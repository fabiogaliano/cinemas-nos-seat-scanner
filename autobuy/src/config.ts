/**
 * Defaults for the run this was built for, so it works with no .env present.
 *
 * Environment always wins: these are fallbacks, not overrides. They exist so a
 * container that lost its config file still buys the right thing.
 */
const env = (key: string, fallback: string) => {
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? fallback : value;
};

/**
 * Personal details and the ntfy topic have no safe fallback: the topic doubles
 * as the command channel, so a guessable one lets anyone trigger a purchase.
 */
const required = (key: string) => {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") throw new Error(`${key} is not set.`);
  return value;
};

export const buyer = {
  name: required("BUYER_NAME"),
  phone: required("BUYER_PHONE"),
  email: required("BUYER_EMAIL"),
};

export const watch = {
  /** Only this operational date triggers a purchase. */
  targetDate: env("WATCH_TARGET_DATE", "2026-08-19"),
  aggregateId: env("WATCH_AGGREGATE_ID", "1e70190b-5cf3-4937-b361-24f67bdd11d0"),
  movieUrl: env("WATCH_MOVIE_URL", "https://www.cinemas.nos.pt/filmes/a-odisseia--imax--514040668.html"),
  cinema: env("WATCH_CINEMA", "Colombo"),
  format: env("WATCH_FORMAT", "imax"),
  ticketCount: Number(env("TICKET_COUNT", "4")),
  /**
   * Prefix match: "20:" catches 20:10, 20:15, 20:30 — whatever NOS schedules
   * that hour. A full "20:10" would mean exactly that time.
   */
  preferredTimes: env("WATCH_PREFERRED_TIMES", "20:").split(",").map((t) => t.trim()).filter(Boolean),
};

export const purchase = {
  /** "buy" fires the MB WAY push automatically; "hold" stops before it. */
  mode: env("PURCHASE_MODE", "buy") as "hold" | "buy",
  /** A full room takes the buffer seat anyway, so this stays off. */
  avoidStrangers: env("AVOID_STRANGERS", "0") === "1",
};

export const notify = {
  topic: required("NTFY_TOPIC"),
};

export const retention = {
  /**
   * On by default: a date opening overnight is exactly when the push goes
   * unapproved, and losing the seats then is the failure this was built to
   * prevent. Set RETAIN_ON_FAILURE=0 to walk away instead.
   */
  onFailure: env("RETAIN_ON_FAILURE", "1") === "1",
  /**
   * How long to keep holding, as a duration rather than a clock time.
   *
   * A time of day gave wildly different protection depending on when NOS
   * happened to publish: a date opening at 03:00 got six hours of holding, one
   * opening at 08:30 got thirty minutes. The point of the hold is to survive
   * until you are awake and have decided, so it is measured from when the hold
   * starts. Ends early whenever you buy or tap "Parar".
   */
  hours: Number(env("RETAIN_HOURS", "24")),
  observeMs: Number(env("OBSERVE_PAYMENT_MS", String(8 * 60_000))),
};

/** When a hold that starts now should give up. */
export function retentionDeadline(from = Date.now()) {
  return from + retention.hours * 60 * 60 * 1000;
}
