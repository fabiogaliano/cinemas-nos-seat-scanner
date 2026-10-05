/**
 * Seat identity, kept free of Playwright so it can be tested directly.
 *
 * A seat is stored as the row plus the numbers NOS prints on the map. Columns
 * are positional and only meaningful within a single render — NOS numbers
 * seats descending, so a column index from one read means nothing in the next.
 * Everything that outlives a page load is expressed in row/number terms and
 * re-resolved against a fresh map.
 */
import type { SeatRow } from "../../src/shared/types";

export type SeatTarget = { row: number; nums: number[] };

/** Resolve stored seat numbers back to columns in a freshly read room. */
export function resolveCols(rows: SeatRow[], target: SeatTarget): number[] | null {
  const row = rows.find((r) => r.row === target.row);
  if (!row) return null;
  const cols = target.nums.map((num) => row.seats.find((seat) => seat.num === num)?.col);
  return cols.every((col): col is number => col !== undefined) ? cols : null;
}

/** Whether every seat of a stored target is currently available. */
export function seatsAreFree(rows: SeatRow[], target: SeatTarget): boolean {
  const row = rows.find((r) => r.row === target.row);
  if (!row) return false;
  return target.nums.every((num) => row.seats.find((seat) => seat.num === num)?.free === true);
}

/**
 * The same two questions for a party seated across more than one row, which
 * happens when no single run was long enough. All-or-nothing: holding half a
 * party's seats is not a useful outcome.
 */
export function allSeatsAreFree(rows: SeatRow[], targets: SeatTarget[]): boolean {
  return targets.every((target) => seatsAreFree(rows, target));
}

export function resolveAllCols(rows: SeatRow[], targets: SeatTarget[]): Array<{ row: number; cols: number[] }> | null {
  const resolved = targets.map((target) => {
    const cols = resolveCols(rows, target);
    return cols ? { row: target.row, cols } : null;
  });
  return resolved.every((entry): entry is { row: number; cols: number[] } => entry !== null) ? resolved : null;
}

/** "row 7 seats 16,17 + row 8 seats 4,5" — for logs and notifications. */
export function describeSeats(targets: SeatTarget[]) {
  return targets.map((t) => `fila ${t.row} lugares ${t.nums.join(", ")}`).join(" + ");
}
