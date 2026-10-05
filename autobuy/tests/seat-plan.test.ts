import { describe, expect, it } from "vitest";
import { planSeats, describePlan } from "../src/seat-plan";
import type { SeatRow } from "../../src/shared/types";

function row(rowNumber: number, states: Array<"free" | "taken">): SeatRow {
  return {
    row: rowNumber,
    seats: states.map((state, col) => ({
      col,
      isSeat: true,
      free: state === "free",
      num: col + 1,
      loveSeat: false,
      handicapped: false,
    })),
  };
}

const F = "free" as const;
const X = "taken" as const;

describe("planSeats", () => {
  it("keeps the party together whenever a single run exists", () => {
    const plan = planSeats([row(1, [F, F, F, F, F])], 4, { strangerPenalty: 0 });
    expect(plan?.split).toBe(false);
    expect(plan?.groups).toHaveLength(1);
    expect(plan?.groups[0].nums).toHaveLength(4);
  });

  it("splits only when no run is long enough, preferring the largest runs", () => {
    // Nowhere seats 4 together: best available is a 3 and a 1, or 2 and 2.
    const rows = [row(1, [F, F, F, X, F]), row(2, [F, F, X, F, F])];
    const plan = planSeats(rows, 4, { strangerPenalty: 0 });
    expect(plan?.split).toBe(true);
    const sizes = plan!.groups.map((g) => g.nums.length).sort((a, b) => b - a);
    expect(sizes[0]).toBeGreaterThanOrEqual(2);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("never reuses a seat across groups", () => {
    const rows = [row(1, [F, F, X, F, F]), row(2, [F, F, X, F, F])];
    const plan = planSeats(rows, 6, { strangerPenalty: 0 });
    const keys = plan!.groups.flatMap((g) => g.cols.map((c) => `${g.row}:${c}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns null when the room cannot seat the party at all", () => {
    expect(planSeats([row(1, [F, X, X, X])], 3, { strangerPenalty: 0 })).toBeNull();
  });

  it("describes a split plan readably", () => {
    expect(describePlan([{ row: 7, cols: [1, 2], nums: [16, 17] }, { row: 8, cols: [3], nums: [4] }]))
      .toBe("row 7 seats 16,17 + row 8 seats 4");
  });
});

/**
 * The stranger-avoidance contract, pinned because it broke silently once:
 * `purchase()` used to destructure `strangerPenalty = 0`, which rewrote the
 * very `undefined` that callers pass to mean "use the ranking's own default".
 * Both settings then produced identical picks and AVOID_STRANGERS=1 did nothing.
 */
describe("stranger avoidance plumbing", () => {
  // Wide row so one seat of centring (1/16 ≈ 0.06) costs less than the 0.15
  // penalty — otherwise centring dominates and the flag cannot show up.
  const wide = (takenCol: number): SeatRow[] => [{
    row: 1,
    seats: Array.from({ length: 33 }, (_, col) => ({
      col,
      isSeat: true,
      free: col !== takenCol,
      num: col + 1,
      loveSeat: false,
      handicapped: false,
    })),
  }];

  const touchesTaken = (rows: SeatRow[], cols: number[], takenCol: number) =>
    cols.some((col) => Math.abs(col - takenCol) === 1);

  it("sits next to an occupied seat when avoidance is explicitly disabled", () => {
    const plan = planSeats(wide(15), 2, { strangerPenalty: 0 });
    expect(touchesTaken(wide(15), plan!.groups[0].cols, 15)).toBe(true);
  });

  it("leaves a gap when no penalty is given, i.e. undefined reaches the ranking", () => {
    // No strangerPenalty key at all — the AVOID_STRANGERS=1 path.
    const plan = planSeats(wide(15), 2);
    expect(touchesTaken(wide(15), plan!.groups[0].cols, 15)).toBe(false);
  });

  it("treats an explicit undefined the same as omitting it", () => {
    const omitted = planSeats(wide(15), 2);
    const explicit = planSeats(wide(15), 2, { strangerPenalty: undefined });
    expect(explicit!.groups[0].cols).toEqual(omitted!.groups[0].cols);
  });
});
