import { describe, expect, it } from "vitest";
import { bestBlock, rankSessions, rowDesirability } from "../src/shared/ranking";
import type { SeatRow, Session } from "../src/shared/types";

function row(rowNumber: number, states: Array<"free" | "taken" | "gap" | "handicapped">): SeatRow {
  return {
    row: rowNumber,
    seats: states.map((state, col) => ({
      col,
      isSeat: state !== "gap",
      free: state === "free" || state === "handicapped",
      num: col + 1,
      loveSeat: false,
      handicapped: state === "handicapped",
    })),
  };
}

function session(uuid: string, time: string, rows: SeatRow[]): Session {
  return { label: uuid, cinema: "A", date: "Hoje", time, uuid, variantId: "2d", variantLabel: "2D", variantPriority: 1, rows };
}

describe("bestBlock", () => {
  it("keeps a party together without crossing an aisle", () => {
    const result = bestBlock([row(4, ["free", "free", "gap", "free", "free"])], 3);
    expect(result).toBeNull();
  });

  it("chooses the most centered contiguous block", () => {
    const result = bestBlock([row(8, ["free", "free", "free", "free", "free"])], 2);
    expect(result?.nums).toEqual([2, 3]);
  });

  it("never recommends accessible seats", () => {
    const result = bestBlock([row(1, ["handicapped", "handicapped", "free", "free", "taken"])], 2);
    expect(result?.cols).toEqual([2, 3]);
  });

  it("returns null when only accessible seats fit the party", () => {
    expect(bestBlock([row(1, ["handicapped", "handicapped"])], 2)).toBeNull();
  });

  it("prefers rows near two thirds back over the front row", () => {
    const open: Array<"free" | "taken" | "gap"> = ["free", "free", "free", "free", "free"];
    const result = bestBlock([row(1, open), row(2, open), row(3, open), row(4, open)], 2);
    expect(result?.row).toBe(3);
  });

  it("avoids sitting directly beside strangers when an equally centered block is free", () => {
    // Cols 1-2 and 2-3 are equally centered, but cols 1-2 touch the taken seat.
    const result = bestBlock([row(1, ["taken", "free", "free", "free", "free"])], 2);
    expect(result?.cols).toEqual([2, 3]);
  });
});

describe("rowDesirability", () => {
  it("measures rows relative to each session's overall fill", () => {
    // Row 2 only exists in a packed room where it barely beats the baseline;
    // row 3 is the clear favorite of a quiet session. Absolute occupancy would
    // rank row 2 (100%) above row 3 (50%).
    const packed = session("1", "21:00", [
      row(1, ["taken", "taken", "taken", "taken", "free"]),
      row(2, ["taken", "taken", "taken", "taken", "taken"]),
    ]);
    const quiet = session("2", "18:00", [row(1, ["free", "free"]), row(3, ["taken", "free"])]);
    const desirability = rowDesirability([packed, quiet]);
    expect(desirability.get(3)!).toBeGreaterThan(desirability.get(2)!);
  });
});

describe("rankSessions", () => {
  it("ranks a viable daytime session before a late session", () => {
    const sessions = [
      session("1", "23:30", [row(1, ["free", "free"])]),
      session("2", "20:00", [row(1, ["free", "free"])]),
    ];
    expect(rankSessions(sessions, 2).map((entry) => entry.uuid)).toEqual(["2", "1"]);
  });
});
