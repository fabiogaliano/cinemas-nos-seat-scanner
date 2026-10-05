/**
 * Reading seat availability without driving a browser.
 *
 * Measured: the SeatsGet screen service answers a plain fetch in ~300-500ms and
 * reserves nothing, where walking the checkout to the seat map takes ~30s and
 * makes NOS auto-pick seats — so every browser "read" briefly holds seats of
 * its own.
 *
 * The only credential it wants is the CSRF token; cookies make no difference
 * (cookie-only and cold calls both 403, csrf-only succeeds). The token is not
 * in the page HTML — that is a 2.3KB shell — so the OutSystems runtime mints
 * it, and one browser visit is still needed to capture it. After that the token
 * is reusable, which is the whole point: bootstrap once, then poll cheaply.
 */
import type { Browser } from "playwright";
import { TICKET_ORIGIN, toRows } from "./checkout";
import type { SeatRow } from "../../src/shared/types";

const SEATS_ENDPOINT =
  `${TICKET_ORIGIN}/Cinemas/screenservices/Cinemas_Bilheteiras_BLOCKS/Blocks/TicketStep2_SelectSeats/DataActionFetch_SeatsGet_ForRoomWithRows`;

export type SeatsReader = {
  sessionUuid: string;
  csrf: string;
  /** The exact request body the page sent; replayed verbatim. */
  body: string;
  userAgent: string;
};

/**
 * Watch one real page load and keep what it sent.
 *
 * Deliberately does not choose a party size: this is the parent scanner's
 * lighter path, enough for the seat map to load.
 */
export async function captureSeatsReader(browser: Browser, sessionUuid: string): Promise<SeatsReader> {
  const context = await browser.newContext({ locale: "pt-PT", viewport: { width: 1365, height: 1000 } });
  const page = await context.newPage();
  let captured: { csrf: string; body: string; userAgent: string } | null = null;

  page.on("request", (request) => {
    if (!request.url().includes("SeatsGet")) return;
    const headers = request.headers();
    captured = {
      csrf: headers["x-csrftoken"] ?? "",
      body: request.postData() ?? "",
      userAgent: headers["user-agent"] ?? "",
    };
  });

  try {
    const seatsPromise = page.waitForResponse((r) => r.url().includes("SeatsGet") && r.ok(), { timeout: 45_000 });
    await page.goto(`${TICKET_ORIGIN}/Cinemas/Ticket?SessionUUID=${sessionUuid}&CorrelationId=poll-${sessionUuid.slice(0, 8)}`, {
      waitUntil: "domcontentloaded", timeout: 45_000,
    });
    await page.waitForTimeout(3500);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>("button,a")]
        .find((b) => /^Aceitar todos$/i.test(b.textContent?.trim() ?? ""));
      el?.click();
    });
    await page.waitForTimeout(1500);
    for (const label of ["Continuar sem registo", "Continuar"]) {
      const button = page.getByRole("button", { name: label, exact: true }).first();
      await button.waitFor({ state: "visible", timeout: 15_000 });
      await button.evaluate((el: HTMLButtonElement) => el.click());
      await page.waitForTimeout(2000);
    }
    await seatsPromise;

    if (!captured) throw new Error("Não consegui capturar o pedido de lugares.");
    const shot = captured as { csrf: string; body: string; userAgent: string };
    if (!shot.csrf) throw new Error("O pedido de lugares não trazia token CSRF.");
    return { sessionUuid, csrf: shot.csrf, body: shot.body, userAgent: shot.userAgent };
  } finally {
    await context.close().catch(() => {});
  }
}

export class SeatsReaderExpired extends Error {
  constructor() {
    super("O token de leitura de lugares expirou.");
  }
}

/**
 * Read the room. Throws SeatsReaderExpired on 403 so the caller can re-capture
 * rather than mistake a stale token for a full house.
 */
export async function readRoom(reader: SeatsReader): Promise<SeatRow[]> {
  const response = await fetch(SEATS_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      accept: "application/json",
      "x-csrftoken": reader.csrf,
      "user-agent": reader.userAgent,
    },
    body: reader.body,
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 403) throw new SeatsReaderExpired();
  if (!response.ok) throw new Error(`SeatsGet ${response.status}`);

  const payload = await response.json() as {
    data?: { QueuesAndSeats_LR?: { List?: Array<{ Row: number; LocalSeats: { List: Array<Record<string, unknown>> } }> } };
  };
  const rows = toRows((payload.data?.QueuesAndSeats_LR?.List ?? []) as never);
  if (rows.length === 0) throw new Error("A sala não devolveu lugares.");
  return rows;
}
