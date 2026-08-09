import { describe, expect, it } from "vitest";
import { bestBlock, rankSessions } from "../src/shared/ranking";
import type { SeatRow, Session } from "../src/shared/types";

function row(rowNumber: number, states: Array<"free" | "taken" | "gap">): SeatRow {
  return {
    row: rowNumber,
    seats: states.map((state, col) => ({
      col,
      isSeat: state !== "gap",
      free: state === "free",
      num: col + 1,
      loveSeat: false,
      handicapped: false,
    })),
  };
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
});

describe("rankSessions", () => {
  it("ranks a viable daytime session before a late session", () => {
    const sessions: Session[] = [
      { label: "late", cinema: "A", date: "Hoje", time: "23:30", uuid: "1", variantId: "2d", variantLabel: "2D", variantPriority: 1, rows: [row(1, ["free", "free"])] },
      { label: "day", cinema: "A", date: "Hoje", time: "20:00", uuid: "2", variantId: "2d", variantLabel: "2D", variantPriority: 1, rows: [row(1, ["free", "free"])] }, 
    ];
    expect(rankSessions(sessions, 2).map((session) => session.uuid)).toEqual(["2", "1"]);
  });
});
