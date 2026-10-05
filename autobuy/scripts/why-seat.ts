/**
 * Explains a seat choice: scores every candidate block in the winning row and
 * prints the score components, so "why not the more central seat?" is answerable
 * from numbers rather than assumption.
 *   bun scripts/why-seat.ts <sessionUuid> [partySize]
 */
import { chromium } from "playwright";
import { bestBlock } from "../../src/shared/ranking";
import type { SeatRow } from "../../src/shared/types";

const uuid = process.argv[2];
const party = Number(process.argv[3] ?? 4);
if (!uuid) throw new Error("usage: bun scripts/why-seat.ts <sessionUuid> [partySize]");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: "pt-PT", viewport: { width: 1365, height: 1000 } });
const seats = page.waitForResponse((r) => r.url().includes("SeatsGet") && r.ok(), { timeout: 45_000 });
await page.goto(`https://bilheteira.cinemas.nos.pt/Cinemas/Ticket?SessionUUID=${uuid}&CorrelationId=why`, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(4000);
await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>("button,a")].find((x) => /^Aceitar todos$/i.test(x.textContent?.trim() ?? ""))?.click(); });
await page.waitForTimeout(1500);
await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>("button")].find((x) => x.textContent?.trim() === "Continuar sem registo")?.click(); });
await page.waitForTimeout(3000);
await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>("button")].find((x) => x.textContent?.trim() === "Continuar")?.click(); });
const payload = await (await seats).json() as { data?: { QueuesAndSeats_LR?: { List?: Array<{ Row: number; LocalSeats: { List: Array<Record<string, unknown>> } }> } } };
await browser.close();

const rows: SeatRow[] = (payload.data?.QueuesAndSeats_LR?.List ?? []).map((r) => ({
  row: r.Row,
  seats: r.LocalSeats.List.map((s) => ({
    col: Number(s.Col), isSeat: Boolean(s.isSeat), free: Boolean(s.isAvailable),
    num: Number(s.SeatNumber), loveSeat: Boolean(s.isLoveSeat), handicapped: Boolean(s.isHandicapped),
  })),
}));

const winner = bestBlock(rows, party);
if (!winner) throw new Error("no block found");
console.log(`bestBlock → row ${winner.row}, nums ${winner.nums.join(",")}, score ${winner.score.toFixed(4)}\n`);

// Re-derive the components for every candidate in that row.
const rowIndex = rows.findIndex((r) => r.row === winner.row);
const row = rows[rowIndex];
const lastRow = rows.length - 1;
const real = row.seats.filter((s) => s.isSeat);
const minCol = Math.min(...real.map((s) => s.col));
const maxCol = Math.max(...real.map((s) => s.col));
const midpoint = (minCol + maxCol) / 2;
const occupied = new Set(real.filter((s) => !s.free).map((s) => s.col));
const freeByCol = new Map(real.filter((s) => s.free && !s.handicapped).map((s) => [s.col, s]));
const depth = lastRow === 0 ? 0.65 : rowIndex / lastRow;
const depthScore = 1 - Math.abs(depth - 0.65) / 0.65;

console.log(`row ${row.row}: cols ${minCol}..${maxCol}, midpoint ${midpoint}, one seat of centring = ${(1 / ((maxCol - minCol) / 2)).toFixed(4)}\n`);
const table: Array<Record<string, string | number>> = [];
for (const seat of freeByCol.values()) {
  const block = Array.from({ length: party }, (_, i) => freeByCol.get(seat.col + i));
  if (block.some((b) => !b)) continue;
  const center = seat.col + (party - 1) / 2;
  const span = (maxCol - minCol) / 2 || 1;
  const centered = 1 - Math.abs(center - midpoint) / span;
  const strangers = Number(occupied.has(seat.col - 1)) + Number(occupied.has(seat.col + party));
  const score = depthScore * 1.2 + centered - strangers * 0.15;
  table.push({
    nums: block.map((b) => b!.num).join(","),
    offCentre: Math.abs(center - midpoint).toFixed(1),
    centered: centered.toFixed(4),
    strangers,
    penalty: (strangers * 0.15).toFixed(2),
    score: score.toFixed(4),
  });
}
table.sort((a, b) => Number(b.score) - Number(a.score));
console.table(table.slice(0, 8));
