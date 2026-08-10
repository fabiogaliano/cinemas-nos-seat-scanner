import { chromium, type Browser, type Page } from "playwright";
import type { Cinema, Discovery, ScanRequest, ScanVariant, Session } from "../shared/types";

const DATE_LABEL = /^(Hoje|Amanh[aã]|[A-Za-zÀ-ÿ-]+-feira\s+\d{2}\/\d{2})$/;
const AGGREGATE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NOS_ORIGIN = "https://www.cinemas.nos.pt";
const SCHEDULE_TTL_MS = 2 * 60 * 1000;
const SESSION_CONCURRENCY = Math.min(4, Math.max(1, Number(process.env.NOS_SCAN_CONCURRENCY) || 2));
const REGION_BY_ID: Record<string, string> = {
  "f989907b-97ae-4ab7-a8a8-b6c22cc8584d": "Grande Lisboa",
  "f889907b-97ae-4ab7-a8a8-b6c22cc8584d": "Grande Porto",
  "26ef691e-ab57-4449-98ca-78460896aa2b": "Norte",
  "9bc0dffe-6a18-4257-86a8-a3a492934055": "Centro",
  "b96ae19e-81ce-4b04-a2c8-0563dffe910d": "Sul",
  "f789907b-97ae-4ab7-a8a8-b6c22cc8584d": "Madeira",
  "0cf6ebc6-de24-42c1-a975-e51cd7db97e3": "Açores",
};

type NosSession = { uuid?: unknown; time?: unknown; format?: unknown };
type NosTheater = { name?: unknown; regionId?: unknown; sessions?: unknown };
type NosDay = { name?: unknown; theaters?: unknown };
type NosSchedule = { days?: unknown };
type DiscoveredSession = Omit<Session, "rows">;
type ScheduleCacheEntry = { expiresAt: number; promise: Promise<NosSchedule> };

const scheduleCache = new Map<string, ScheduleCacheEntry>();

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function assertNosUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.cinemas.nos.pt" || !url.pathname.startsWith("/filmes/")) {
    throw new Error("Usa um link de filme de www.cinemas.nos.pt.");
  }
  return url.toString();
}

function assertAggregateId(value: string) {
  if (!AGGREGATE_ID.test(value)) throw new Error("O identificador do filme é inválido.");
  return value;
}

async function fetchSchedule(aggregateId: string) {
  const id = assertAggregateId(aggregateId);
  const response = await fetch(`${NOS_ORIGIN}/bin/cinemas/render/getMovieSessions.getMovieSessionsAggregator.json?aggregateMovieId=${id}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("Não foi possível carregar as sessões da NOS.");
  const text = new TextDecoder("windows-1252").decode(await response.arrayBuffer());
  const schedule = JSON.parse(text) as NosSchedule;
  if (!Array.isArray(schedule.days)) throw new Error("A NOS devolveu sessões inválidas.");
  return schedule;
}

function getSchedule(aggregateId: string) {
  const id = assertAggregateId(aggregateId);
  const current = scheduleCache.get(id);
  if (current && current.expiresAt > Date.now()) return current.promise;
  const promise = fetchSchedule(id);
  const entry = { expiresAt: Date.now() + SCHEDULE_TTL_MS, promise };
  scheduleCache.set(id, entry);
  void promise.catch(() => {
    if (scheduleCache.get(id) === entry) scheduleCache.delete(id);
  });
  return promise;
}

function scheduleDays(schedule: NosSchedule): NosDay[] {
  return Array.isArray(schedule.days) ? schedule.days.filter((day): day is NosDay => Boolean(day) && typeof day === "object") : [];
}

function dayTheaters(day: NosDay): NosTheater[] {
  return Array.isArray(day.theaters) ? day.theaters.filter((theater): theater is NosTheater => Boolean(theater) && typeof theater === "object") : [];
}

function theaterSessions(theater: NosTheater): NosSession[] {
  return Array.isArray(theater.sessions) ? theater.sessions.filter((session): session is NosSession => Boolean(session) && typeof session === "object") : [];
}

export function cinemasFromSchedule(schedule: NosSchedule): Cinema[] {
  const cinemas = new Map<string, Cinema>();
  for (const day of scheduleDays(schedule)) {
    for (const theater of dayTheaters(day)) {
      const name = string(theater.name);
      if (!name) continue;
      const current = cinemas.get(name) ?? { name, region: REGION_BY_ID[string(theater.regionId)] ?? "Outros", formats: [] };
      for (const session of theaterSessions(theater)) {
        const format = string(session.format);
        if (format && !current.formats.includes(format)) current.formats.push(format);
      }
      if (current.formats.length) cinemas.set(name, current);
    }
  }
  return [...cinemas.values()];
}

function sessionsFromSchedule(schedule: NosSchedule, request: ScanRequest, variant: ScanVariant): DiscoveredSession[] {
  const selected = new Set(request.cinemas);
  const sessions: DiscoveredSession[] = [];
  for (const day of scheduleDays(schedule).slice(0, request.days)) {
    const date = string(day.name);
    if (!date) continue;
    for (const theater of dayTheaters(day)) {
      const fullName = string(theater.name);
      const cinema = fullName.replace(/^Cinemas NOS\s+/, "");
      if (!selected.has(fullName) && !selected.has(cinema)) continue;
      for (const value of theaterSessions(theater)) {
        const uuid = string(value.uuid);
        const time = string(value.time);
        if (!uuid || !time) continue;
        sessions.push({
          cinema,
          time,
          uuid,
          variantId: variant.id,
          variantLabel: variant.label,
          variantPriority: variant.priority,
          date,
          label: `${variant.label} · ${cinema} · ${date}, ${time}`,
        });
      }
    }
  }
  return sessions;
}

async function launch() {
  return chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
}

async function fastPage(browser: Browser) {
  const page = await browser.newPage({ locale: "pt-PT", viewport: { width: 1365, height: 900 } });
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    return type === "image" || type === "media" || type === "font" ? route.abort() : route.continue();
  });
  return page;
}

async function moviePage(browser: Browser, movieUrl: string) {
  const page = await fastPage(browser);
  await page.goto(assertNosUrl(movieUrl), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector(".movie-detail__sessions-list__container__theater", { timeout: 30_000 });
  return page;
}

async function readMovieTitle(page: Page) {
  return page.evaluate(() => document.querySelector("h1")?.textContent?.trim() || document.title.split("|")[0]?.trim() || "Filme");
}

async function discoverWithBrowser(movieUrl: string): Promise<Discovery> {
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
      for (const option of document.querySelectorAll<HTMLOptionElement>("option[data-region-id]")) regionIdByCinema[option.value] = option.dataset.regionId ?? "";
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

export async function discover(movieUrl: string, aggregateId?: string, movieTitle = "Filme"): Promise<Discovery> {
  const validatedUrl = assertNosUrl(movieUrl);
  if (!aggregateId) return discoverWithBrowser(validatedUrl);
  const schedule = await getSchedule(aggregateId);
  return { movieUrl: validatedUrl, movieTitle, cinemas: cinemasFromSchedule(schedule) };
}

async function discoverSessionsWithBrowser(page: Page, request: ScanRequest, variant: ScanVariant): Promise<DiscoveredSession[]> {
  const dateLabels = (await page.locator("button").allTextContents())
    .map((label) => label.trim())
    .filter((label) => DATE_LABEL.test(label))
    .slice(0, request.days);
  const selected = new Set(request.cinemas);
  const sessions: DiscoveredSession[] = [];

  for (const date of dateLabels) {
    await page.getByRole("button", { name: date, exact: true }).evaluate((element: HTMLButtonElement) => element.click());
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
  await button.evaluate((element: HTMLButtonElement) => new Promise<void>((resolve, reject) => {
    const press = () => {
      if (element.disabled) return false;
      element.click();
      resolve();
      return true;
    };
    if (press()) return;
    const observer = new MutationObserver(() => {
      if (press()) observer.disconnect();
    });
    observer.observe(element, { attributes: true, attributeFilter: ["disabled"] });
    window.setTimeout(() => { observer.disconnect(); reject(new Error("O botão da bilheteira não ficou disponível.")); }, 12_000);
  }));
}

async function scanSession(page: Page, session: DiscoveredSession): Promise<Session> {
  const ticketUrl = `https://bilheteira.cinemas.nos.pt/Cinemas/Ticket?SessionUUID=${session.uuid}&CorrelationId=scan-${session.uuid.slice(0, 8)}`;
  await page.goto(ticketUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await clickWhenAvailable(page, "Continuar sem registo");
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("SeatsGet") && response.ok(),
    { timeout: 35_000 },
  );
  await clickWhenAvailable(page, "Continuar");
  const response = await responsePromise;
  const payload = await response.json() as {
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
  const browserPromise = launch();
  let browser: Browser | undefined;
  try {
    const variants = [...request.variants].sort((a, b) => a.priority - b.priority);
    const discovered = await Promise.all(variants.map(async (variant) => {
      if (variant.aggregateId) return sessionsFromSchedule(await getSchedule(variant.aggregateId), request, variant);
      const currentBrowser = await browserPromise;
      const page = await moviePage(currentBrowser, variant.movieUrl);
      try {
        return discoverSessionsWithBrowser(page, request, variant);
      } finally {
        await page.close();
      }
    }));
    const sessions = discovered.flat();
    hooks.onDiscovered(request.movieTitle, sessions.length);
    if (sessions.length === 0) throw new Error("Não encontrámos sessões com estes filtros.");

    browser = await browserPromise;
    let cursor = 0;
    let completed = 0;
    let successful = 0;
    const worker = async () => {
      while (true) {
        if (hooks.signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
        const index = cursor++;
        const session = sessions[index];
        if (!session) return;
        const ticketPage = await fastPage(browser!);
        try {
          const result = await scanSession(ticketPage, session);
          if (hooks.signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
          successful += 1;
          completed += 1;
          hooks.onSession(result, completed, sessions.length);
        } catch (error) {
          if (hooks.signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
          completed += 1;
          hooks.onSessionError(session, completed, sessions.length, error instanceof Error ? error : new Error("A sessão falhou."));
        } finally {
          await ticketPage.close();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SESSION_CONCURRENCY, sessions.length) }, worker));
    if (successful === 0) throw new Error("Não foi possível ler nenhuma das sessões encontradas.");
  } finally {
    browser ??= await browserPromise.catch(() => undefined);
    await browser?.close();
  }
}
