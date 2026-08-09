import type { BestBlock, RankedSession, SeatRow, Session } from "./types";

const seatCount = (row: SeatRow) => row.seats.filter((seat) => seat.isSeat).length;
const freeCount = (row: SeatRow) => row.seats.filter((seat) => seat.isSeat && seat.free).length;

export function rowDesirability(sessions: Session[]) {
  const stats = new Map<number, { occupied: number; samples: number }>();
  for (const session of sessions) {
    for (const row of session.rows) {
      const total = seatCount(row);
      if (total === 0) continue;
      const current = stats.get(row.row) ?? { occupied: 0, samples: 0 };
      current.occupied += (total - freeCount(row)) / total;
      current.samples += 1;
      stats.set(row.row, current);
    }
  }
  return new Map([...stats].map(([row, value]) => [row, value.occupied / value.samples]));
}

export function bestBlock(rows: SeatRow[], partySize: number, desirability = new Map<number, number>()): BestBlock | null {
  let best: BestBlock | null = null;
  for (const row of rows) {
    const realSeats = row.seats.filter((seat) => seat.isSeat);
    if (realSeats.length === 0) continue;

    const minCol = Math.min(...realSeats.map((seat) => seat.col));
    const maxCol = Math.max(...realSeats.map((seat) => seat.col));
    const midpoint = (minCol + maxCol) / 2;
    const freeByCol = new Map(row.seats.filter((seat) => seat.isSeat && seat.free).map((seat) => [seat.col, seat]));

    for (const seat of freeByCol.values()) {
      const block = Array.from({ length: partySize }, (_, index) => freeByCol.get(seat.col + index));
      if (block.some((candidate) => !candidate)) continue;
      const center = seat.col + (partySize - 1) / 2;
      const span = (maxCol - minCol) / 2 || 1;
      const centered = 1 - Math.abs(center - midpoint) / span;
      const score = (desirability.get(row.row) ?? 0) * 2 + centered;
      if (!best || score > best.score) {
        best = {
          row: row.row,
          cols: block.map((candidate) => candidate!.col),
          nums: block.map((candidate) => candidate!.num),
          score,
        };
      }
    }
  }
  return best;
}

export function rankSessions(sessions: Session[], partySize: number): RankedSession[] {
  const desirability = rowDesirability(sessions);
  return sessions
    .map((session) => {
      const totalSeats = session.rows.reduce((sum, row) => sum + seatCount(row), 0);
      const totalFree = session.rows.reduce((sum, row) => sum + freeCount(row), 0);
      const [hours, minutes] = session.time.split(":").map(Number);
      return {
        ...session,
        best: bestBlock(session.rows, partySize, desirability),
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
