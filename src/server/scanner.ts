import { chromium, type Browser, type Page } from "playwright";
import type { Cinema, Discovery, ScanRequest, ScanVariant, Session } from "../shared/types";

const DATE_LABEL = /^(Hoje|Amanh[aã]|[A-Za-zÀ-ÿ-]+-feira\s+\d{2}\/\d{2})$/;

function assertNosUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.cinemas.nos.pt" || !url.pathname.startsWith("/filmes/")) {
    throw new Error("Usa um link de filme de www.cinemas.nos.pt.");
  }
  return url.toString();
}

async function launch() {
  return chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
}

async function moviePage(browser: Browser, movieUrl: string) {
  const page = await browser.newPage({ locale: "pt-PT", viewport: { width: 1365, height: 900 } });
  await page.goto(assertNosUrl(movieUrl), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector(".movie-detail__sessions-list__container__theater", { timeout: 30_000 });
  return page;
}

async function readMovieTitle(page: Page) {
  return page.evaluate(() => document.querySelector("h1")?.textContent?.trim() || document.title.split("|")[0]?.trim() || "Filme");
}

export async function discover(movieUrl: string): Promise<Discovery> {
  const browser = await launch();
  try {
    const page = await moviePage(browser, movieUrl);
    const result = await page.evaluate(() => {
      const regionNameById: Record<string, string> = {};
      for (const checkbox of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        if (checkbox.id === "all") continue;
        const label = checkbox.closest("label")?.textContent?.trim()
          ?? document.querySelector<HTMLLabelElement>(`label[for="${checkbox.id}"]`)?.textContent?.trim();
        if (label) regionNameById[checkbox.id] = label;
      }
      const regionIdByCinema: Record<string, string> = {};
      for (const option of document.querySelectorAll<HTMLOptionElement>("option[data-region-id]")) {
        regionIdByCinema[option.value] = option.dataset.regionId ?? "";
      }
      const cinemas: Cinema[] = Array.from(document.querySelectorAll<HTMLElement>(".movie-detail__sessions-list__container__theater"))
        .map((container) => {
          const name = container.dataset.name ?? container.querySelector(".movie-detail__sessions-list__theater-title")?.textContent?.trim() ?? "";
          return {
            name,
            region: regionNameById[regionIdByCinema[name]] ?? "Outros",
            formats: Array.from(container.querySelectorAll<HTMLElement>("[data-format]"))
              .map((element) => element.dataset.format ?? "")
              .filter((format, index, formats) => Boolean(format) && formats.indexOf(format) === index),
          };
        })
        .filter((cinema) => cinema.name && cinema.formats.length > 0);
      const heading = document.querySelector("h1")?.textContent?.trim();
      const fallback = document.title.split("|")[0]?.trim();
      return { movieTitle: heading || fallback || "Filme", cinemas };
    });
    return { movieUrl: assertNosUrl(movieUrl), ...result };
  } finally {
    await browser.close();
  }
}

type DiscoveredSession = Omit<Session, "rows">;

async function discoverSessions(page: Page, request: ScanRequest, variant: ScanVariant): Promise<DiscoveredSession[]> {
  const dateLabels = (await page.locator("button").allTextContents())
    .map((label) => label.trim())
    .filter((label) => DATE_LABEL.test(label))
    .slice(0, request.days);
  const selected = new Set(request.cinemas);
  const sessions: DiscoveredSession[] = [];

  for (const date of dateLabels) {
    const button = page.getByRole("button", { name: date, exact: true });
    await button.evaluate((element: HTMLButtonElement) => element.click());
    await page.waitForTimeout(800);
    const found = await page.evaluate(({ cinemaNames }) => {
      const output: Array<{ cinema: string; time: string; uuid: string }> = [];
      for (const container of document.querySelectorAll<HTMLElement>(".movie-detail__sessions-list__container__theater")) {
        const fullName = container.dataset.name ?? container.querySelector(".movie-detail__sessions-list__theater-title")?.textContent?.trim() ?? "";
        const shortName = fullName.replace(/^Cinemas NOS\s+/, "");
        if (!cinemaNames.includes(fullName) && !cinemaNames.includes(shortName)) continue;
        for (const formatBlock of container.querySelectorAll<HTMLElement>("[data-format]")) {
          for (const sessionButton of formatBlock.querySelectorAll<HTMLButtonElement>("button[data-uuid]")) {
            output.push({ cinema: shortName, time: sessionButton.textContent?.trim() ?? "", uuid: sessionButton.dataset.uuid ?? "" });
          }
        }
      }
      return output;
    }, { cinemaNames: [...selected] });
    sessions.push(...found.filter((session) => session.uuid).map((session) => ({
      ...session,
      variantId: variant.id,
      variantLabel: variant.label,
      variantPriority: variant.priority,
      date,
      label: `${variant.label} · ${session.cinema} · ${date}, ${session.time}`,
    })));
  }
  return sessions;
}

async function clickWhenAvailable(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await button.waitFor({ state: "visible", timeout: 12_000 });
  await button.evaluate((element: HTMLButtonElement) => element.click());
  await page.waitForTimeout(900);
}

async function scanSession(page: Page, session: DiscoveredSession): Promise<Session> {
  const ticketUrl = `https://bilheteira.cinemas.nos.pt/Cinemas/Ticket?SessionUUID=${session.uuid}&CorrelationId=scan-${session.uuid.slice(0, 8)}`;
  await page.goto(ticketUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await clickWhenAvailable(page, "Continuar sem registo");
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("SeatsGet") && response.ok(),
    { timeout: 35_000 },
  ).then((response) => ({ response }), (error: Error) => ({ error }));
  await clickWhenAvailable(page, "Continuar");
  const captured = await responsePromise;
  if ("error" in captured) throw captured.error;
  const payload = await captured.response.json() as {
    data?: { QueuesAndSeats_LR?: { List?: Array<{ Row: number; LocalSeats: { List: Array<Record<string, unknown>> } }> } };
  };
  const rows = (payload.data?.QueuesAndSeats_LR?.List ?? []).map((row) => ({
    row: row.Row,
    seats: row.LocalSeats.List.map((seat) => ({
      col: Number(seat.Col),
      isSeat: Boolean(seat.isSeat),
      free: Boolean(seat.isAvailable),
      num: Number(seat.SeatNumber),
      loveSeat: Boolean(seat.isLoveSeat),
      handicapped: Boolean(seat.isHandicapped),
    })).sort((a, b) => a.col - b.col),
  })).filter((row) => row.seats.some((seat) => seat.isSeat));
  if (rows.length === 0) throw new Error("A sala não devolveu lugares.");
  return { ...session, rows };
}

export async function scan(
  request: ScanRequest,
  hooks: {
    signal: AbortSignal;
    onDiscovered: (movieTitle: string, total: number) => void;
    onSession: (session: Session, index: number, total: number) => void;
    onSessionError: (session: DiscoveredSession, index: number, total: number, error: Error) => void;
  },
) {
  const browser = await launch();
  try {
    const sessions: DiscoveredSession[] = [];
    let movieTitle = request.movieTitle;
    for (const variant of [...request.variants].sort((a, b) => a.priority - b.priority)) {
      const page = await moviePage(browser, variant.movieUrl);
      try {
        if (movieTitle === "Filme") movieTitle = await readMovieTitle(page);
        sessions.push(...await discoverSessions(page, request, variant));
      } finally {
        await page.close();
      }
    }
    hooks.onDiscovered(movieTitle, sessions.length);
    if (sessions.length === 0) throw new Error("Não encontrámos sessões com estes filtros.");

    let successful = 0;
    for (const [index, session] of sessions.entries()) {
      if (hooks.signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
      const ticketPage = await browser.newPage({ locale: "pt-PT", viewport: { width: 1365, height: 900 } });
      try {
        const result = await scanSession(ticketPage, session);
        successful += 1;
        hooks.onSession(result, index + 1, sessions.length);
      } catch (error) {
        if (hooks.signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
        hooks.onSessionError(session, index + 1, sessions.length, error instanceof Error ? error : new Error("A sessão falhou."));
      } finally {
        await ticketPage.close();
      }
    }
    if (successful === 0) throw new Error("Não foi possível ler nenhuma das sessões encontradas.");
  } finally {
    await browser.close();
  }
}
