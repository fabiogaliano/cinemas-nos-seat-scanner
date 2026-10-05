/**
 * The NOS OutSystems checkout, one function per screen.
 *
 * Extracted from purchase.ts so the retention loop can drive the same flow
 * without duplicating selectors: every quirk documented here cost real time to
 * find, and two copies would drift apart at the worst moment.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import type { SeatRow } from "../../src/shared/types";

export const TICKET_ORIGIN = "https://bilheteira.cinemas.nos.pt";
// Screenshots live beside the rest of the app state so they work in the
// container, where docs/ is not copied into the image. Resolved from the module
// URL rather than import.meta.dir, which is Bun-only and undefined under the
// test runner.
const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CINEMAS_DATA_DIR ?? join(HERE, "../../data");

/**
 * Measured, not guessed: DT01_Get_NumberOfTickets_and_TimeToPurchase returns
 * TimeToReservedSeat=300000, and the client starts a plain setTimeout for that
 * long when the Ticket screen loads. Nothing restarts it — advancing a step
 * does not buy more time — and when it fires the app navigates to
 * Page_PurchaseOutOfTime and the seats are released.
 */
export const PURCHASE_WINDOW_MS = 300_000;

const SESSION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type RawSeat = { Col: unknown; isSeat: unknown; isAvailable: unknown; SeatNumber: unknown; isLoveSeat: unknown; isHandicapped: unknown };
type RawRow = { Row: number; LocalSeats: { List: RawSeat[] } };

export function assertSessionUuid(value: string) {
  if (!SESSION_UUID.test(value)) throw new Error("O identificador da sessão é inválido.");
  return value;
}

/** True once the countdown has fired and NOS has dropped the booking. */
export function isTimedOut(page: Page) {
  return /PurchaseOutOfTime/i.test(page.url());
}

// Clicks through the OutSystems overlay: the cookie banner sits above the flow
// and intercepts pointer events, so a plain Playwright click times out.
export async function forceClick(page: Page, label: string, timeout = 15_000) {
  const button = page.getByRole("button", { name: label, exact: true }).first();
  await button.waitFor({ state: "visible", timeout });
  await button.evaluate((el: HTMLButtonElement) => el.click());
  await page.waitForTimeout(2000);
}

export async function clickByText(page: Page, pattern: RegExp) {
  return page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const leaf = [...document.querySelectorAll<HTMLElement>("*")]
      .find((el) => el.children.length === 0 && re.test(el.textContent ?? ""));
    if (!leaf) return false;
    (leaf.closest("a,button,label,li,div[onclick]") as HTMLElement | null ?? leaf).click();
    return true;
  }, pattern.source);
}

// Party size is a row of `div.card-choosenumber` cards, not buttons, so it is
// unreachable by role. The chosen one carries `isSelected`.
export async function choosePartySize(page: Page, size: number) {
  const ok = await page.evaluate((want) => {
    const card = [...document.querySelectorAll<HTMLElement>(".card-choosenumber")]
      .find((el) => el.textContent?.trim() === String(want));
    if (!card) return false;
    card.click();
    return true;
  }, size);
  if (!ok) throw new Error(`Não foi possível escolher ${size} bilhetes.`);
  await page.waitForTimeout(1500);
  const confirmed = await page.evaluate((want) => {
    const card = [...document.querySelectorAll<HTMLElement>(".card-choosenumber.isSelected")][0];
    return card?.textContent?.trim() === String(want);
  }, size);
  if (!confirmed) throw new Error(`A seleção de ${size} bilhetes não foi aceite.`);
}

export async function dismissCookies(page: Page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>("button,a")]
      .find((b) => /^Aceitar todos$/i.test(b.textContent?.trim() ?? ""));
    el?.click();
  });
  await page.waitForTimeout(1500);
}

/**
 * The rendered seat map carries no row or seat identity — each seat is a bare
 * `div.o-compraSeat` with only a state modifier — so the only way to click a
 * specific seat is by position. We therefore keep the SeatsGet payload
 * unfiltered, so its rows line up index-for-index with the rendered ones, and
 * verify the mapping afterwards by reading back the labels NOS itself displays.
 */
export function toRows(raw: RawRow[]): SeatRow[] {
  // Deliberately unsorted: index within LocalSeats.List is the index of the
  // rendered `.o-compraSeat`, and NOS numbers seats descending, so sorting by
  // col silently breaks every position we later click. bestBlock keys off
  // `col` rather than array order, so it is unaffected.
  return raw.map((row) => ({
    row: row.Row,
    seats: row.LocalSeats.List.map((seat) => ({
      col: Number(seat.Col),
      isSeat: Boolean(seat.isSeat),
      free: Boolean(seat.isAvailable),
      num: Number(seat.SeatNumber),
      loveSeat: Boolean(seat.isLoveSeat),
      handicapped: Boolean(seat.isHandicapped),
    })),
  }));
}

/**
 * Take exactly these seats, which may span more than one row when the party
 * could not be seated together. The auto-pick is cleared once up front: doing
 * it per group would wipe the groups already chosen.
 */
export async function selectSeats(
  page: Page,
  rows: SeatRow[],
  target: { row: number; cols: number[] } | Array<{ row: number; cols: number[] }>,
) {
  const groups = Array.isArray(target) ? target : [target];
  const want = groups.reduce((total, group) => total + group.cols.length, 0);

  // Resolve every seat to its rendered position before touching anything, so a
  // bad plan fails before half of it has been clicked.
  const positions = groups.map((group) => {
    const rowIndex = rows.findIndex((row) => row.row === group.row);
    if (rowIndex < 0) throw new Error("A fila escolhida não existe no mapa.");
    const colIndexes = group.cols.map((col) => rows[rowIndex].seats.findIndex((seat) => seat.col === col));
    if (colIndexes.some((index) => index < 0)) throw new Error("Os lugares escolhidos não existem na fila.");
    return { rowIndex, colIndexes };
  });

  // Real mouse clicks, not in-page el.click(): OutSystems only commits the
  // selection (and enables "Continuar") on a genuine pointer interaction.
  // No `force` — if something overlays the map we want to be told, not to
  // silently click through it.
  const seatAt = (rowIndex: number, index: number) =>
    page.locator(".o-cinema-map__seats .-seatContainer").nth(rowIndex).locator("[class*=compraSeat]").nth(index);
  const countChosen = () => page.locator(".o-cinema-map__seats .o-compraSeat.-chosen").count();

  // NOS refuses a new seat while the party quota is already filled — it warns
  // rather than swapping — so the auto-pick has to be cleared first. Real
  // pointer clicks make this work; in-page el.click() does not.
  for (let guard = 0; guard < want + 2; guard++) {
    const chosen = page.locator(".o-cinema-map__seats .o-compraSeat.-chosen").first();
    if (await chosen.count() === 0) break;
    await chosen.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);

  let reason = "";
  for (const { rowIndex, colIndexes } of positions) {
    for (const index of colIndexes) {
      const cls = await seatAt(rowIndex, index).getAttribute("class") ?? "";
      if (cls.includes("-chosen")) continue;
      if (!cls.includes("-free")) { reason = `row ${rowIndex} index ${index} is "${cls.trim()}"`; break; }
      await seatAt(rowIndex, index).click({ timeout: 8000 });
      await page.waitForTimeout(600);
    }
    if (reason) break;
  }

  const onTarget = await Promise.all(positions.flatMap(({ rowIndex, colIndexes }) =>
    colIndexes.map(async (index) => ((await seatAt(rowIndex, index).getAttribute("class")) ?? "").includes("-chosen"))));

  const chosen = await countChosen();
  return { ok: !reason && onTarget.every(Boolean), reason: reason || (onTarget.every(Boolean) ? "" : "targets did not take"), chosen };
}

export async function readSelection(page: Page) {
  return page.evaluate(() => {
    const match = document.body.innerText.match(/Lugares selecionados:\s*([\s\S]{1,40}?)\s*(?:Voltar|Continuar|\n\n|$)/i);
    return match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  });
}

/** Which of the seven checkout screens is currently rendered. */
export async function whereAmI(page: Page) {
  return page.evaluate(() => {
    const t = document.body.innerText;
    if (/Os bilhetes ser(ã|a)o enviados/i.test(t)) return "confirm";
    if (/Introduza os seus dados pessoais/i.test(t)) return "details";
    if (/Deseja algum artigo de bar/i.test(t)) return "bar";
    if (/Tem algum benef(í|i)cio/i.test(t)) return "benefits";
    if (/Quais os lugares que deseja/i.test(t)) return "seats";
    if (/Quantas pessoas v(ã|a)o/i.test(t)) return "party";
    return "unknown";
  });
}

/**
 * Escalating patience between steps.
 *
 * NOS puts a blocking loader over the flow while it fetches the next screen.
 * A click during that window is simply swallowed — the button is present and
 * looks enabled, but nothing happens. Fixed waits therefore fail intermittently
 * and unpredictably, which is exactly how this flow has been misbehaving.
 */
const BACKOFF_MS = [5_000, 10_000, 15_000];

/** True while NOS is showing a loader or the document is still working. */
async function isBusy(page: Page) {
  return page.evaluate(() => {
    if (document.readyState !== "complete") return true;
    const selector = '[class*="loading"],[class*="Loading"],[class*="spinner"],[class*="Spinner"],[aria-busy="true"]';
    return [...document.querySelectorAll(selector)].some((element) => {
      const el = element as HTMLElement;
      if (el.offsetParent === null) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    });
  }).catch(() => false);
}

/** Wait until nothing is loading, so the next interaction is not swallowed. */
export async function settle(page: Page, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isBusy(page))) {
      // A loader that has just gone still leaves handlers being bound.
      await page.waitForTimeout(400);
      if (!(await isBusy(page))) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/** Poll for the screen to change, rather than assuming one pause is enough. */
async function waitForScreenChange(page: Page, from: string, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const now = await whereAmI(page).catch(() => from);
    if (now !== from) return now;
  }
  return "";
}

/**
 * Advance one screen, waiting out the loader and escalating patience until the
 * click actually takes. Verifies the move rather than assuming it: a swallowed
 * click would otherwise abandon the whole purchase three screens early.
 */
export async function advance(page: Page, from: string, label = "Continuar") {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    await settle(page);
    await forceClick(page, label);
    const moved = await waitForScreenChange(page, from, 6_000 + attempt * 3_000);
    if (moved) return moved;
    const pause = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    console.warn(`  · "${label}" did not move off "${from}"; waiting ${pause / 1000}s and retrying`);
    await page.waitForTimeout(pause);
  }
  throw new Error(`O passo "${from}" não avançou ao clicar "${label}" (${BACKOFF_MS.length + 1} tentativas).`);
}

export async function readTotal(page: Page) {
  return page.evaluate(() => (document.body.innerText.match(/€\s?[\d.,]+/) ?? [""])[0].trim());
}

/** Film, showing and cinema, as printed on the seat screen. */
export async function readShowing(page: Page) {
  return page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, " ");
    const when = text.match(/((?:Segunda|Ter(?:ç|c)a|Quarta|Quinta|Sexta|S(?:á|a)bado|Domingo)[^€]{0,60}?\d{1,2}:\d{2}h)/i)?.[1] ?? "";
    const cinema = text.match(/(Cinemas NOS [A-Za-zÀ-ÿ ]+)/)?.[1] ?? "";
    return { title: document.querySelector("h1")?.textContent?.trim() ?? "Filme", when: when.trim(), cinema: cinema.trim() };
  });
}

export type Buyer = { name: string; phone: string; email: string };

/**
 * From wherever the flow currently is, walk to the personal-details screen,
 * fill it, and take it through paygate to MB WAY. In "buy" mode this presses
 * "Pagar agora" and a real push goes to the phone; in "hold" mode it stops with
 * the button armed and untouched.
 *
 * Lifted verbatim out of purchase() so the retention loop drives the same
 * tested sequence — every wait here was tuned against the live site, and a
 * second copy would drift.
 */
export async function payFromCheckout(
  page: Page,
  options: { buyer: Buyer; mode: "hold" | "buy"; step?: (name: string) => void },
) {
  const { buyer, mode, step = () => {} } = options;

  // The bar/benefits screens are conditional, so walk by detected screen
  // rather than assuming a fixed number of clicks.
  let screen = await whereAmI(page);
  step(`screen: ${screen}`);
  for (let guard = 0; guard < 6 && screen !== "details"; guard++) {
    screen = await advance(page, screen);
    step(`screen: ${screen}`);
  }
  if (screen !== "details") throw new Error(`Não cheguei ao formulário de dados (fiquei em "${screen}").`);

  // Let the form finish mounting before touching it. Typing one second after
  // the screen appears produced fields that kept a single character of what was
  // typed — OutSystems is still binding the inputs and wipes what it finds.
  await settle(page);
  await page.waitForTimeout(1500);

  const total = await readTotal(page);

  /**
   * Type for real, then check what actually landed.
   *
   * A scripted value assignment updates the DOM but not OutSystems' own model,
   * so the form reports every field as empty — hence real key events. But those
   * race the field's own handler: an email was observed arriving as "mail.com"
   * instead of "someone@gmail.com", the leading characters swallowed by a
   * re-render mid-entry. NOS then rejects the form, bounces back a screen, and
   * the whole purchase dies — intermittently, which is what made it look random.
   *
   * So verify and retype. Never submit a field we have not read back.
   */
  const typeInto = async (suffix: string, value: string) => {
    const field = page.locator(`input[id$="${suffix}"]`).first();
    await field.waitFor({ state: "visible", timeout: 15_000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await field.click();
      await field.fill("");
      await page.waitForTimeout(150);
      await field.pressSequentially(value, { delay: 35 });
      await field.blur().catch(() => {});
      await page.waitForTimeout(300);
      const landed = await field.inputValue();
      if (landed === value) return;
      step(`field ${suffix} came out as "${landed}"; retyping`);
      await page.waitForTimeout(500);
    }
    throw new Error(`O campo ${suffix} não aceitou o valor correto ao fim de 3 tentativas.`);
  };
  await typeInto("Input_Name", buyer.name);
  await typeInto("Input_PhoneNumber", buyer.phone);
  await typeInto("Input_Email", buyer.email);
  await typeInto("Input_Email_Confirm", buyer.email);
  await page.waitForTimeout(1200);

  // The details form validates server-side; if anything was rejected the page
  // silently stays put and "Pagar" never appears. And the submit click is as
  // swallowable as any other, so it gets the same escalating patience.
  const readGate = () => page.evaluate(() => ({
    reachedConfirm: /Os bilhetes ser(ã|a)o enviados/i.test(document.body.innerText),
    errors: [...document.querySelectorAll<HTMLElement>("*")]
      .filter((e) => e.children.length === 0 && /obrigat(ó|o)rio|inv(á|a)lid/i.test(e.textContent ?? ""))
      .map((e) => e.textContent?.trim() ?? "")
      // Every details screen carries this sentence whether or not anything is
      // wrong, so reporting it as an error sends you hunting a phantom.
      .filter((text) => !/^Todos os campos assinalados/i.test(text))
      .slice(0, 6),
    values: ["Input_Name", "Input_PhoneNumber", "Input_Email", "Input_Email_Confirm"]
      .map((s) => `${s}=${document.querySelector<HTMLInputElement>(`input[id$="${s}"]`)?.value ?? "?"}`),
  }));

  /** Give the confirmation screen time to render before judging the submit. */
  const awaitConfirm = async (timeout: number) => {
    const deadline = Date.now() + timeout;
    let seen = await readGate();
    while (!seen.reachedConfirm && Date.now() < deadline) {
      await page.waitForTimeout(500);
      seen = await readGate();
    }
    return seen;
  };

  let gate = await readGate();
  for (let attempt = 0; attempt <= BACKOFF_MS.length && !gate.reachedConfirm; attempt++) {
    if (attempt > 0) {
      const pause = BACKOFF_MS[attempt - 1];
      step(`details form did not advance; waiting ${pause / 1000}s and re-submitting`);
      await page.waitForTimeout(pause);
      // A successful submit removes this button, so its absence means we have
      // already moved on and must not "retry" a form that is no longer there.
      const stillOnForm = await page.getByRole("button", { name: "Continuar", exact: true })
        .first().isVisible().catch(() => false);
      if (!stillOnForm) {
        gate = await awaitConfirm(15_000);
        break;
      }
    }
    await settle(page);
    await forceClick(page, "Continuar");   // details -> email confirmation
    gate = await awaitConfirm(10_000);
  }
  if (!gate.reachedConfirm) {
    throw new Error(`O formulário de dados pessoais não avançou. Erros: ${gate.errors.join(" | ") || "(nenhum)"} — valores: ${gate.values.join(", ")}`);
  }
  step("email confirmation");
  // Wait for the handoff to actually happen rather than assuming a fixed pause
  // covers it: the redirect to the PSP was observed still pending after 5s,
  // which then surfaced as the misleading "paygate did not offer MB WAY".
  const onPaygate = () => /paygate\.nos\.pt/i.test(page.url());
  for (let attempt = 0; attempt <= BACKOFF_MS.length && !onPaygate(); attempt++) {
    if (attempt > 0) {
      const pause = BACKOFF_MS[attempt - 1];
      step(`"Pagar" did not hand off (still on ${new URL(page.url()).host}); waiting ${pause / 1000}s`);
      await page.waitForTimeout(pause);
    }
    await settle(page);
    await forceClick(page, "Pagar");       // -> paygate.nos.pt
    await page.waitForURL(/paygate\.nos\.pt/i, { timeout: 45_000 }).catch(() => {});
  }
  if (!onPaygate()) throw new Error(`O clique em "Pagar" não chegou ao paygate (ainda em ${new URL(page.url()).host}).`);
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  step(`paygate: ${new URL(page.url()).host}`);

  if (!(await clickByText(page, /MB\s?WAY/))) throw new Error("O paygate não ofereceu MB WAY.");
  step("MB WAY selected");
  await page.waitForTimeout(3000);

  // Type the number for real: paygate only enables "Pagar agora" on genuine
  // keyboard input, so a scripted value assignment leaves the button dead.
  const phoneInput = page.locator("#phoneNumberId");
  await phoneInput.waitFor({ state: "visible", timeout: 15_000 });
  await phoneInput.click();
  await phoneInput.fill("");
  await phoneInput.pressSequentially(buyer.phone, { delay: 90 });
  await phoneInput.blur().catch(() => {});
  await page.waitForTimeout(1500);

  const payButton = page.getByRole("button", { name: "Pagar agora", exact: true }).first();
  const typed = await phoneInput.inputValue();
  const enabled = await payButton.isEnabled().catch(() => false);
  step(`phone="${typed}" payButtonEnabled=${enabled}`);
  if (typed !== buyer.phone) throw new Error(`O número não ficou correto no paygate: "${typed}".`);

  let pushSent = false;
  if (mode === "buy") {
    step("pressing 'Pagar agora' — this pushes to the phone");
    // The button animates continuously, so Playwright's stability check never
    // settles. Enabled state and the typed number are both verified above,
    // which is what the check would have been protecting us from.
    await payButton.click({ timeout: 20_000, force: true });
    await page.waitForTimeout(9000);
    pushSent = true;
    const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400));
    step(`paygate says: ${after}`);
  } else {
    step("hold mode — stopping here, no push sent");
  }
  return { total, pushSent };
}

export type PaymentOutcome = "approved" | "dead" | "unknown";

/**
 * Watch the paygate after a push until it stops being pending.
 *
 * The pending wording is observed: "É necessário aprovar o pagamento na App MB
 * WAY dentro de 5 minutos, senão será cancelado", beside a live countdown that
 * starts at 05:55 despite the sentence saying five minutes. The terminal
 * wording is not observed — confirming it would mean approving a real payment —
 * so anything unrecognised returns "unknown" rather than a guess.
 *
 * "unknown" is treated as not-bought by callers. That is the safe direction:
 * the worst case is holding seats we already own, which shows up immediately as
 * seats that never come free, whereas assuming success would drop seats we
 * still need.
 */
export async function observePayment(
  page: Page,
  options: { timeoutMs?: number; pollMs?: number; step?: (name: string) => void } = {},
): Promise<{ outcome: PaymentOutcome; text: string }> {
  const { timeoutMs = 8 * 60_000, pollMs = 10_000, step = () => {} } = options;
  const deadline = Date.now() + timeoutMs;
  let text = "";

  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400)).catch(() => "");
    const url = page.url();

    // Leaving paygate at all means the PSP finished with us; it hands back to
    // NOS only once there is a result to show.
    if (text && !/paygate\.nos\.pt/i.test(url) && !/Pagamento Online/i.test(text)) {
      step(`payment: left paygate → ${url}`);
      return { outcome: /sucesso|aprovad|obrigad|bilhetes/i.test(text) ? "approved" : "unknown", text };
    }
    if (/pagamento\s+(aprovad|conclu|efetuad)/i.test(text)) return { outcome: "approved", text };
    if (/expirou|expirad|cancelad|recusad|insucesso|n(ã|a)o foi poss(í|i)vel/i.test(text)) {
      step("payment: paygate reports the request is dead");
      return { outcome: "dead", text };
    }
    // Still counting down: "05 : 55" style, or the instruction sentence.
    const pending = /\d{1,2}\s*:\s*\d{2}/.test(text) || /aprovar o pagamento/i.test(text);
    if (!pending && text) {
      step("payment: countdown gone, wording unrecognised");
      return { outcome: "unknown", text };
    }
    await page.waitForTimeout(pollMs);
  }
  return { outcome: "unknown", text };
}

export type OpenCheckout = {
  context: BrowserContext;
  page: Page;
  rows: SeatRow[];
  /** When the countdown started — page load, not seat selection. */
  loadedAt: number;
  expiresAt: number;
};

/**
 * Walk to the seat map in a fresh cookie jar and return the room NOS reported.
 *
 * `ticketCount` commits the party step the way a real buyer does, which the
 * seat widget requires before it will accept a selection. Omit it to take the
 * lighter path the parent app's scanner uses, which is enough to read
 * availability but leaves the widget uncommitted.
 */
export async function openCheckout(
  browser: Browser,
  sessionUuid: string,
  options: { ticketCount?: number; tag?: string } = {},
): Promise<OpenCheckout> {
  const uuid = assertSessionUuid(sessionUuid);
  const { ticketCount, tag = "buy" } = options;
  const context = await browser.newContext({ locale: "pt-PT", viewport: { width: 1365, height: 1000 } });
  const page = await context.newPage();
  const seatsPromise = page.waitForResponse((r) => r.url().includes("SeatsGet") && r.ok(), { timeout: 45_000 });

  const loadedAt = Date.now();
  await page.goto(`${TICKET_ORIGIN}/Cinemas/Ticket?SessionUUID=${uuid}&CorrelationId=${tag}-${uuid.slice(0, 8)}`, {
    waitUntil: "domcontentloaded", timeout: 45_000,
  });
  await page.waitForTimeout(3500);
  await dismissCookies(page);
  await forceClick(page, "Continuar sem registo");
  if (ticketCount !== undefined) await choosePartySize(page, ticketCount);
  await forceClick(page, "Continuar");

  const payload = await (await seatsPromise).json() as { data?: { QueuesAndSeats_LR?: { List?: RawRow[] } } };
  const rows = toRows(payload.data?.QueuesAndSeats_LR?.List ?? []);
  if (rows.length === 0) throw new Error("A sala não devolveu lugares.");
  return { context, page, rows, loadedAt, expiresAt: loadedAt + PURCHASE_WINDOW_MS };
}
