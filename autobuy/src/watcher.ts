import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSchedule } from "../../src/server/scanner";
import { purchase, type PurchaseMode } from "./purchase";
import { retain, type RetentionOutcome } from "./retention";
import { notifyText, notifyWithImage } from "./notify";
import { captureSchedule } from "./schedule-shot";

// Resolved from the module URL rather than import.meta.dir, which is Bun-only
// and undefined under the test runner.
const DATA_DIR = process.env.CINEMAS_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../data");
const STATE_FILE = join(DATA_DIR, "watch-state.json");

export type WatchedSession = { date: string; time: string; uuid: string; format: string; cinema: string; dayLabel: string };
type State = { seen: Record<string, string> };

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Every session at the configured cinema/format, keyed by real operational date. */
export function sessionsFor(schedule: unknown, cinema: string, format: string): WatchedSession[] {
  const days = (schedule as { days?: unknown }).days;
  if (!Array.isArray(days)) throw new Error("A NOS devolveu sessões inválidas.");
  const out: WatchedSession[] = [];
  for (const day of days) {
    const dayLabel = str((day as { name?: unknown }).name);
    for (const theater of (day as { theaters?: unknown[] }).theaters ?? []) {
      const name = str((theater as { name?: unknown }).name);
      if (!name.toLowerCase().includes(cinema.toLowerCase())) continue;
      for (const session of (theater as { sessions?: unknown[] }).sessions ?? []) {
        const s = session as Record<string, unknown>;
        const fmt = str(s.format);
        if (format && fmt.toLowerCase() !== format.toLowerCase()) continue;
        const date = str(s.operationalDate).slice(0, 10);
        const time = str(s.time);
        const uuid = str(s.uuid);
        if (date && time && uuid) out.push({ date, time, uuid, format: fmt, cinema: name, dayLabel });
      }
    }
  }
  return out;
}

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
    if (parsed && typeof parsed.seen === "object") return parsed;
  } catch {
    // First run, or a truncated file — treat as empty rather than crash the loop.
  }
  return { seen: {} };
}

async function writeState(state: State) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STATE_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, STATE_FILE);
}

/**
 * Which showing to buy when a date opens. Entries match as prefixes, so "20:"
 * still catches the session if NOS moves it from 20:10 to 20:15, while "20:10"
 * stays exact. No fallback beyond the listed patterns: cinema tickets are not
 * refundable (art. 17 DL 24/2014, per the checkout page), so guessing a
 * different showing is the one mistake that cannot be undone.
 */
export function pickSession(sessions: WatchedSession[], preferred: string[]): WatchedSession | null {
  for (const pattern of preferred) {
    const matches = sessions
      .filter((s) => s.time.startsWith(pattern))
      .sort((a, b) => a.time.localeCompare(b.time));
    if (matches.length) return matches[0];
  }
  return null;
}

/**
 * Which newly opened dates are worth buying.
 *
 * With a target date, only that one qualifies: a different day opening first
 * must never trigger a purchase, because tickets are not refundable and buying
 * the wrong day is the one mistake that cannot be undone. Without one, the
 * earliest new date wins, which is the original behaviour.
 */
export function actionableDates(fresh: string[], targetDate?: string): string[] {
  const wanted = targetDate?.trim();
  return wanted ? fresh.filter((date) => date === wanted) : [...fresh];
}

export async function checkOnce(options: {
  aggregateId: string;
  cinema: string;
  format: string;
  preferredTimes: string[];
  ticketCount: number;
  mode: PurchaseMode;
  buyer: { name: string; phone: string; email: string };
  notifyTopic: string;
  /** Film page used for the "wanted showing missing" screenshot. */
  movieUrl?: string;
  headless?: boolean;
  seedOnly?: boolean;
  /**
   * Only buy when this exact operational date opens, "YYYY-MM-DD". Without it
   * the first new date to appear is bought, whichever it is.
   */
  targetDate?: string;
  /** Hold the seats when the push is not confirmed, instead of losing them. */
  retainOnFailure?: boolean;
  /** How many hours to keep holding before giving up. */
  retainHours?: number;
  /** How long to watch the paygate before deciding the push failed. */
  observeMs?: number;
}) {
  // Bypass the CDN copy: it is served well past its stated max-age, and the
  // whole point of watching is to reach a newly published date before the good
  // seats go.
  const schedule = await fetchSchedule(options.aggregateId, { fresh: true });
  const sessions = sessionsFor(schedule, options.cinema, options.format);
  const state = await readState();

  const dates = [...new Set(sessions.map((s) => s.date))].sort();
  const fresh = dates.filter((date) => !state.seen[date]);

  // A first run must record the existing window rather than try to buy all of it.
  if (options.seedOnly || Object.keys(state.seen).length === 0) {
    const now = new Date().toISOString();
    for (const date of dates) state.seen[date] ??= now;
    await writeState(state);
    return { dates, fresh: options.seedOnly ? [] : fresh, seeded: true, bought: null };
  }

  if (fresh.length === 0) return { dates, fresh, seeded: false, bought: null };

  const actionable = actionableDates(fresh, options.targetDate);
  if (actionable.length === 0) {
    const now = new Date().toISOString();
    for (const date of fresh) state.seen[date] ??= now;
    await writeState(state);
    return { dates, fresh, seeded: false, bought: null };
  }

  const target = actionable.sort()[0];
  const chosen = pickSession(sessions.filter((s) => s.date === target), options.preferredTimes);
  state.seen[target] = new Date().toISOString();
  await writeState(state);
  if (!chosen) {
    // Silence here would look identical to "nothing happened", so say so — and
    // show the schedule, since the point is to decide whether to buy by hand.
    const onDate = sessions.filter((s) => s.date === target);
    const available = onDate.map((s) => s.time).join(", ") || "nenhuma";
    const title = `${target} abriu - sem sessao ${options.preferredTimes.join("/")}`;
    const message = `Sessoes disponiveis: ${available}. Nada foi comprado - compra manual.`;

    const shot = join(DATA_DIR, "schedule-alert.png");
    const captured = options.movieUrl
      ? await captureSchedule({ movieUrl: options.movieUrl, dayLabel: onDate[0]?.dayLabel ?? "", outPath: shot })
          .then(() => true).catch(() => false)
      : false;

    await (captured
      ? notifyWithImage({ topic: options.notifyTopic, imagePath: shot, title, message, priority: "urgent", tags: ["warning"] })
      : notifyText({ topic: options.notifyTopic, title, message, priority: "urgent" })
    ).catch(() => undefined);
    return { dates, fresh, seeded: false, bought: null };
  }

  let result;
  try {
    result = await purchase(chosen.uuid, {
      ticketCount: options.ticketCount,
      mode: options.mode,
      buyer: options.buyer,
      notifyTopic: options.notifyTopic,
      headless: options.headless ?? true,
      strangerPenalty: 0,
      observeMs: options.retainOnFailure ? options.observeMs ?? 8 * 60_000 : 0,
    });
  } catch (error) {
    // The date is already marked seen, so nothing will retry this purchase.
    // A console line at 03:00 reaches nobody; the phone must hear it, because
    // buying by hand right now is the only remaining move.
    const reason = error instanceof Error ? error.message : String(error);
    await notifyText({
      topic: options.notifyTopic,
      title: `COMPRA FALHOU - ${target} ${chosen.time}`,
      message: `${reason}. Nada foi comprado e nao vou tentar outra vez - compra manual.`,
      priority: "urgent",
    }).catch(() => undefined);
    throw error;
  }

  // A date opening at 03:00 is exactly when nobody taps the push. Rather than
  // lose the seats to a sleeping phone, keep re-taking them until morning.
  // "unknown" counts as unconfirmed: see observePayment on why that is the safe
  // direction.
  let retention: RetentionOutcome | undefined;
  if (options.retainOnFailure && result.pushSent && result.outcome !== "approved" && result.wanted) {
    retention = await retain({
      sessionUuid: chosen.uuid,
      ticketCount: options.ticketCount,
      seats: result.wanted,
      buyer: options.buyer,
      notifyTopic: options.notifyTopic,
      until: Date.now() + (options.retainHours ?? 24) * 60 * 60 * 1000,
      headless: options.headless ?? true,
    });
  }
  return { dates, fresh, seeded: false, bought: { session: chosen, result, retention } };
}
