/**
 * Run the purchase flow against one session.
 *   bun scripts/buy.ts <sessionUuid> [hold|buy]
 * Mode defaults to PURCHASE_MODE in .env, and to "hold" if that is unset.
 */
import { purchase, type PurchaseMode } from "../src/purchase";
import { buyer, notify, purchase as purchaseConfig, retention, retentionDeadline, watch } from "../src/config";
import { describeSeats } from "../src/seats";

const uuid = process.argv[2];
if (!uuid) throw new Error("usage: bun scripts/buy.ts <sessionUuid> [hold|buy]");

const mode = (process.argv[3] ?? purchaseConfig.mode) as PurchaseMode;
if (mode !== "hold" && mode !== "buy") throw new Error(`mode must be "hold" or "buy", got "${mode}"`);

const ticketsFlag = process.argv.findIndex((a) => a === "--tickets");
const ticketCount = Number(ticketsFlag > -1 ? process.argv[ticketsFlag + 1] : watch.ticketCount);
if (!Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > 6) {
  throw new Error(`tickets must be 1-6 (NOS's own limit), got "${ticketCount}"`);
}
// Watchable by default when asked for; slowMo makes the clicks followable.
const headed = process.argv.includes("--headed") || process.env.HEADED === "1";
console.log(`mode=${mode} tickets=${ticketCount} headed=${headed} session=${uuid}`);

// Off by default: for a film that sells out, the buffer seat gets taken anyway.
const strangerPenalty = purchaseConfig.avoidStrangers ? undefined : 0;

// Holding the seats after a failed payment only makes sense if we waited long
// enough to know it failed.
const retainAfter = retention.onFailure && mode === "buy";
const result = await purchase(uuid, {
  ticketCount, mode, buyer,
  headless: !headed,
  slowMo: headed ? 400 : 0,
  strangerPenalty,
  notifyTopic: notify.topic,
  observeMs: retainAfter ? retention.observeMs : 0,
});
console.log("\n--- result ---");
console.log(JSON.stringify(result, null, 2));
console.log(
  result.pushSent
    ? "\nMB WAY push sent — approve it in the app to complete, or ignore it to let it expire."
    : "\nStopped on the paygate page. No push sent.",
);

if (retainAfter && result.outcome !== "approved" && result.wanted) {
  // "unknown" lands here too. If the payment did go through, the seats simply
  // never come free again and retention reports that — whereas walking away
  // from a payment that failed loses the seats for good.
  console.log(`\nPayment not confirmed (${result.outcome}); holding ${describeSeats(result.wanted)} until told otherwise.`);
  const { retain } = await import("../src/retention");
  const outcome = await retain({
    sessionUuid: uuid,
    ticketCount,
    seats: result.wanted,
    buyer,
    notifyTopic: notify.topic,
    until: retentionDeadline(),
    headless: !headed,
  });
  console.log("\n--- retention ---");
  console.log(JSON.stringify(outcome, null, 2));
}
