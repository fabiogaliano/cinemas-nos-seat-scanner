import { describe, expect, it } from "vitest";
import { actionableDates } from "../src/watcher";

/**
 * Buying the wrong day is the one unrecoverable mistake here — cinema tickets
 * are not refundable — so the target-date filter is worth pinning down.
 */
describe("actionableDates", () => {
  const fresh = ["2026-08-17", "2026-08-19", "2026-08-20"];

  it("acts only on the target when one is set", () => {
    expect(actionableDates(fresh, "2026-08-19")).toEqual(["2026-08-19"]);
  });

  it("acts on nothing when the target has not opened yet", () => {
    // The dates that did open are recorded by the caller, but none is bought.
    expect(actionableDates(["2026-08-17", "2026-08-20"], "2026-08-19")).toEqual([]);
  });

  it("falls back to every new date when no target is set", () => {
    expect(actionableDates(fresh)).toEqual(fresh);
    expect(actionableDates(fresh, "")).toEqual(fresh);
    expect(actionableDates(fresh, "   ")).toEqual(fresh);
  });

  it("does not mutate the caller's list", () => {
    const input = ["2026-08-19"];
    actionableDates(input).push("2026-08-25");
    expect(input).toEqual(["2026-08-19"]);
  });
});
