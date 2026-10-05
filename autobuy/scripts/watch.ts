/**
 * Watches for a newly published date and buys the moment one appears.
 *   bun scripts/watch.ts            # loop every 5 minutes
 *   bun scripts/watch.ts --once     # single check
 *   bun scripts/watch.ts --seed     # record today's window without buying
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkOnce } from "../src/watcher";
import { buyer, notify, purchase, retention, watch } from "../src/config";

const argv = new Set(process.argv.slice(2));

const options = {
  aggregateId: watch.aggregateId,
  cinema: watch.cinema,
  format: watch.format,
  preferredTimes: watch.preferredTimes,
  ticketCount: watch.ticketCount,
  mode: purchase.mode,
  buyer,
  notifyTopic: notify.topic,
  movieUrl: watch.movieUrl,
  headless: true,
  seedOnly: argv.has("--seed"),
  targetDate: watch.targetDate,
  retainOnFailure: retention.onFailure,
  retainHours: retention.hours,
  observeMs: retention.observeMs,
};

/**
 * The CDN serves this past its own max-age — a plain read was measured at
 * age=534s on a 300s policy — so checkOnce cache-busts to reach origin. That
 * makes a shorter interval worth something: the whole point is to reach a newly
 * published date before its best seats go.
 */
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS ?? 60_000);

// Touched every tick so the container healthcheck can tell "running" from
// "wedged" — a watcher that dies quietly is indistinguishable from one with
// nothing to report.
const HEARTBEAT = join(process.env.CINEMAS_DATA_DIR ?? join(import.meta.dir, "../data"), "watch-heartbeat");

async function beat() {
  await mkdir(dirname(HEARTBEAT), { recursive: true }).catch(() => {});
  await writeFile(HEARTBEAT, new Date().toISOString()).catch(() => {});
}

// A purchase already outlasts the 5-minute interval, and retention can hold for
// hours, so ticks would otherwise pile up and start a second purchase on top of
// one in flight.
let inFlight = false;

async function tick() {
  const stamp = new Date().toISOString().slice(11, 19);
  if (inFlight) {
    console.log(`${stamp} still busy with the previous check; skipping`);
    return;
  }
  inFlight = true;
  try {
    const result = await checkOnce(options);
    if (result.seeded) {
      console.log(`${stamp} seeded ${result.dates.length} dates: ${result.dates.join(", ")}`);
    } else if (result.bought) {
      const { session, result: purchased, retention } = result.bought;
      console.log(`${stamp} NEW DATE ${session.date} ${session.time} → ${purchased.selectedLabel} (push=${purchased.pushSent}, payment=${purchased.outcome ?? "not watched"})`);
      if (retention) console.log(`${stamp} retention ended: ${retention.status} after ${retention.cycles} cycles (${retention.reason})`);
    } else if (result.fresh.length) {
      console.log(`${stamp} new dates ${result.fresh.join(", ")} but no session matched`);
    } else {
      console.log(`${stamp} no change (${result.dates.length} dates, latest ${result.dates.at(-1)})`);
    }
  } catch (error) {
    console.error(`${stamp} check failed:`, error instanceof Error ? error.message : error);
  } finally {
    inFlight = false;
  }
}

console.log(`watching ${options.cinema} ${options.format} · ${options.ticketCount} tickets · mode=${options.mode} · prefer ${options.preferredTimes.join(" > ")}`);
await beat();
await tick();
if (!argv.has("--once") && !argv.has("--seed")) {
  // Separate from the check: a retention hold can run for hours, and a watcher
  // that is working hard must not look wedged to the healthcheck.
  setInterval(() => void beat(), 60_000);
  setInterval(tick, INTERVAL_MS);
}
