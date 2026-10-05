/**
 * What to take when the party does not fit in one contiguous run.
 *
 * `bestBlock` answers "the best N seats together, or nothing". On a busy
 * showing that is often nothing — and the fallback used to be NOS's own
 * auto-pick, which nobody chose and nobody saw coming. This keeps the choice
 * with the ranking: take the best run it can find, then the best run for
 * whoever is left, until the party is seated.
 *
 * Splitting a party is a real cost, so it is never preferred — a single block
 * always wins when one exists, and the caller is told when a plan is split so
 * it can say so.
 */
import { bestBlock } from "../../src/shared/ranking";
import type { SeatRow } from "../../src/shared/types";

export type SeatGroup = { row: number; cols: number[]; nums: number[] };

/** Copy with a set of seats marked taken, so the next pick cannot reuse them. */
function without(rows: SeatRow[], taken: SeatGroup[]): SeatRow[] {
  const claimed = new Set(taken.flatMap((g) => g.cols.map((col) => `${g.row}:${col}`)));
  return rows.map((row) => ({
    ...row,
    seats: row.seats.map((seat) => claimed.has(`${row.row}:${seat.col}`) ? { ...seat, free: false } : seat),
  }));
}

/**
 * Seats for `count` people, best-first, split only when unavoidable.
 * Returns null when the room cannot seat the party at all.
 */
export function planSeats(
  rows: SeatRow[],
  count: number,
  options: { strangerPenalty?: number } = {},
): { groups: SeatGroup[]; split: boolean } | null {
  const whole = bestBlock(rows, count, undefined, options);
  if (whole) return { groups: [{ row: whole.row, cols: whole.cols, nums: whole.nums }], split: false };

  const groups: SeatGroup[] = [];
  let remaining = count;
  while (remaining > 0) {
    // Largest run first: two pairs beat four singles.
    let picked: SeatGroup | null = null;
    for (let size = remaining; size >= 1; size--) {
      const block = bestBlock(without(rows, groups), size, undefined, options);
      if (block) {
        picked = { row: block.row, cols: block.cols, nums: block.nums };
        break;
      }
    }
    if (!picked) return null;
    groups.push(picked);
    remaining -= picked.cols.length;
  }
  return { groups, split: true };
}

/** "row 7 seats 16,17 + row 8 seats 4,5", for logs and notifications. */
export function describePlan(groups: SeatGroup[]) {
  return groups.map((g) => `row ${g.row} seats ${g.nums.join(",")}`).join(" + ");
}
