import { afterEach, describe, expect, it, vi } from "vitest";
import { readCommand, commandButtons, controlTopicFor } from "../src/control";
import { resolveCols, seatsAreFree } from "../src/seats";
import type { SeatRow } from "../../src/shared/types";

/**
 * NOS numbers seats descending across a row, so `num` deliberately runs the
 * opposite way to `col` here — sorting one by the other is the exact mistake
 * that silently retargets every seat.
 */
function row(rowNumber: number, states: Array<"free" | "taken">): SeatRow {
  const count = states.length;
  return {
    row: rowNumber,
    seats: states.map((state, col) => ({
      col,
      isSeat: true,
      free: state === "free",
      num: count - col,
      loveSeat: false,
      handicapped: false,
    })),
  };
}

describe("resolveCols", () => {
  it("maps stored seat numbers back to columns regardless of ordering", () => {
    const rows = [row(4, ["free", "free", "free", "free"])];
    // nums 4..1 map to cols 0..3
    expect(resolveCols(rows, { row: 4, nums: [3, 2] })).toEqual([1, 2]);
  });

  it("returns null when the row is gone from the map", () => {
    expect(resolveCols([row(4, ["free"])], { row: 9, nums: [1] })).toBeNull();
  });

  it("returns null when a seat number no longer exists", () => {
    expect(resolveCols([row(4, ["free", "free"])], { row: 4, nums: [2, 99] })).toBeNull();
  });
});

describe("seatsAreFree", () => {
  it("is true only when every seat of the block is available", () => {
    const rows = [row(4, ["free", "taken", "free"])];
    expect(seatsAreFree(rows, { row: 4, nums: [3] })).toBe(true);
    expect(seatsAreFree(rows, { row: 4, nums: [3, 2] })).toBe(false);
  });

  it("is false for a row or seat that is not there", () => {
    expect(seatsAreFree([row(4, ["free"])], { row: 7, nums: [1] })).toBe(false);
    expect(seatsAreFree([row(4, ["free"])], { row: 4, nums: [42] })).toBe(false);
  });
});

describe("commandButtons", () => {
  it("scopes both actions to the run's nonce", () => {
    const actions = commandButtons("topic-control", "n0nce");
    expect(actions).toContain("body=go-n0nce");
    expect(actions).toContain("body=stop-n0nce");
    // Without clear=true an http action gives no feedback at all on the phone.
    expect(actions).toContain("clear=true");
  });

  it("keeps taps off the alert topic", () => {
    expect(controlTopicFor("seats-abc")).toBe("seats-abc-control");
  });
});

describe("readCommand", () => {
  const lines = (...messages: Array<{ message: string; time: number }>) =>
    messages.map((m) => JSON.stringify(m)).join("\n");

  const mockNtfy = (body: string) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

  afterEach(() => vi.unstubAllGlobals());

  it("returns the newest command when a tap arrives duplicated", async () => {
    // A single press really does deliver several copies; acting on each one
    // would fire a payment push per duplicate.
    mockNtfy(lines(
      { message: "go-abc", time: 100 },
      { message: "go-abc", time: 100 },
      { message: "go-abc", time: 101 },
    ));
    expect(await readCommand({ controlTopic: "t", nonce: "abc", sinceSeconds: 50 }))
      .toEqual({ command: "go", atSeconds: 101 });
  });

  it("prefers stop when both buttons were pressed at the same second", async () => {
    mockNtfy(lines({ message: "go-abc", time: 100 }, { message: "stop-abc", time: 100 }));
    expect(await readCommand({ controlTopic: "t", nonce: "abc", sinceSeconds: 50 }))
      .toEqual({ command: "stop", atSeconds: 100 });
  });

  it("takes the later press when the two differ in time", async () => {
    mockNtfy(lines({ message: "stop-abc", time: 100 }, { message: "go-abc", time: 140 }));
    expect(await readCommand({ controlTopic: "t", nonce: "abc", sinceSeconds: 50 }))
      .toEqual({ command: "go", atSeconds: 140 });
  });

  it("ignores commands at or before the cursor, so an acted-on tap cannot re-fire", async () => {
    mockNtfy(lines({ message: "go-abc", time: 100 }));
    expect(await readCommand({ controlTopic: "t", nonce: "abc", sinceSeconds: 100 })).toBeNull();
  });

  it("ignores another run's nonce", async () => {
    mockNtfy(lines({ message: "go-otherrun", time: 100 }));
    expect(await readCommand({ controlTopic: "t", nonce: "abc", sinceSeconds: 50 })).toBeNull();
  });

  it("survives the keepalive and open events ntfy interleaves", async () => {
    mockNtfy([
      JSON.stringify({ event: "open", time: 90 }),
      "",
      JSON.stringify({ event: "keepalive", time: 95 }),
      JSON.stringify({ message: "go-abc", time: 120 }),
    ].join("\n"));
    expect(await readCommand({ controlTopic: "t", nonce: "abc", sinceSeconds: 50 }))
      .toEqual({ command: "go", atSeconds: 120 });
  });
});
