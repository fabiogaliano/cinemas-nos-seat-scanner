import type { BestBlock, RankedSession, SeatRow, Session } from "./types";

const seatCount = (row: SeatRow) => row.seats.filter((seat) => seat.isSeat).length;
const freeCount = (row: SeatRow) => row.seats.filter((seat) => seat.isSeat && seat.free).length;

// Viewing sweet spot (SMPTE/THX guidance): centered, roughly two thirds of the way back.
const IDEAL_DEPTH = 0.65;

// Crowd signal must be relative to each session's overall fill, otherwise popular
// sessions inflate every row and a lone session scores its own occupancy back to
// itself. Subtracting the session mean isolates "people pick this row first".
export function rowDesirability(sessions: Session[]) {
  const stats = new Map<number, { delta: number; samples: number }>();
  for (const session of sessions) {
    const usable = session.rows.filter((row) => seatCount(row) > 0);
    if (usable.length === 0) continue;
    const occupancies = usable.map((row) => (seatCount(row) - freeCount(row)) / seatCount(row));
    const sessionMean = occupancies.reduce((sum, value) => sum + value, 0) / occupancies.length;
    usable.forEach((row, index) => {
      const current = stats.get(row.row) ?? { delta: 0, samples: 0 };
      current.delta += occupancies[index] - sessionMean;
      current.samples += 1;
      stats.set(row.row, current);
    });
  }
  return new Map([...stats].map(([row, value]) => [row, value.delta / value.samples]));
}

// Sitting beside a stranger is worth avoiding for some films and irrelevant for
// others, so the weight is a knob rather than a constant. At 0.15 it outweighs
// roughly three seats of centering, which is why turning it off visibly pulls
// picks back towards the middle.
export const STRANGER_PENALTY = 0.15;

export function bestBlock(
  rows: SeatRow[],
  partySize: number,
  desirability = new Map<number, number>(),
  { strangerPenalty = STRANGER_PENALTY }: { strangerPenalty?: number } = {},
): BestBlock | null {
  let best: BestBlock | null = null;
  const lastRow = rows.length - 1;
  rows.forEach((row, rowIndex) => {
    const realSeats = row.seats.filter((seat) => seat.isSeat);
    if (realSeats.length === 0) return;

    const minCol = Math.min(...realSeats.map((seat) => seat.col));
    const maxCol = Math.max(...realSeats.map((seat) => seat.col));
    const midpoint = (minCol + maxCol) / 2;
    const occupiedCols = new Set(realSeats.filter((seat) => !seat.free).map((seat) => seat.col));
    // Accessible seats are excluded so we never recommend taking them from someone
    // who needs one; they still act as occupied neighbors below.
    const freeByCol = new Map(realSeats.filter((seat) => seat.free && !seat.handicapped).map((seat) => [seat.col, seat]));

    // Rows render front (screen) to back; punish sitting too close harder than too far.
    const depth = lastRow === 0 ? IDEAL_DEPTH : rowIndex / lastRow;
    const depthScore = 1 - Math.abs(depth - IDEAL_DEPTH) / IDEAL_DEPTH;

    for (const seat of freeByCol.values()) {
      const block = Array.from({ length: partySize }, (_, index) => freeByCol.get(seat.col + index));
      if (block.some((candidate) => !candidate)) continue;
      const center = seat.col + (partySize - 1) / 2;
      const span = (maxCol - minCol) / 2 || 1;
      const centered = 1 - Math.abs(center - midpoint) / span;
      const strangers =
        Number(occupiedCols.has(seat.col - 1)) + Number(occupiedCols.has(seat.col + partySize));
      const score =
        depthScore * 1.2 +
        centered +
        (desirability.get(row.row) ?? 0) * 0.8 -
        strangers * strangerPenalty;
      if (!best || score > best.score) {
        best = {
          row: row.row,
          cols: block.map((candidate) => candidate!.col),
          nums: block.map((candidate) => candidate!.num),
          score,
        };
      }
    }
  });
  return best;
}

export function rankSessions(
  sessions: Session[],
  partySize: number,
  desirability = rowDesirability(sessions),
  options: { strangerPenalty?: number } = {},
): RankedSession[] {
  return sessions
    .map((session) => {
      const totalSeats = session.rows.reduce((sum, row) => sum + seatCount(row), 0);
      const totalFree = session.rows.reduce((sum, row) => sum + freeCount(row), 0);
      const [hours, minutes] = session.time.split(":").map(Number);
      return {
        ...session,
        best: bestBlock(session.rows, partySize, desirability, options),
        totalSeats,
        totalFree,
        minutes: hours * 60 + minutes,
        occupancy: totalSeats === 0 ? 0 : (totalSeats - totalFree) / totalSeats,
      };
    })
    .sort((a, b) => {
      const aLate = a.minutes >= 23 * 60 || a.minutes < 5 * 60;
      const bLate = b.minutes >= 23 * 60 || b.minutes < 5 * 60;
      if (aLate !== bLate) return aLate ? 1 : -1;
      if (Boolean(a.best) !== Boolean(b.best)) return a.best ? -1 : 1;
      return (b.best?.score ?? -1) - (a.best?.score ?? -1) || a.minutes - b.minutes;
    });
}
