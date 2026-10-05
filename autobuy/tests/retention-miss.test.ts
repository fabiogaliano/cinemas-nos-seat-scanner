import { describe, expect, it } from "vitest";
import { assessMiss } from "../src/retention";

/**
 * Regression tests for the bug that lost a real set of seats.
 *
 * A payment attempt holds the seats for ~20 minutes, so retention waits out a
 * lockout before concluding anything. The original code incremented the miss
 * counter during that wait, so after 35 expected misses it was already far past
 * the give-up threshold of 5 — and quit on its very first real attempt,
 * reporting "lost after 0 cycles".
 */
describe("assessMiss", () => {
  const lostAfter = 5;
  const lockoutUntil = 1_000_000;

  it("never gives up while locked out, however many misses accumulate", () => {
    let misses = 0;
    for (let i = 0; i < 40; i++) {
      const r = assessMiss({ now: lockoutUntil - 1000, lockoutUntil, misses, lostAfter });
      expect(r.lockedOut).toBe(true);
      expect(r.giveUp).toBe(false);
      misses = r.misses;
    }
    // The counter must be clean when the lockout ends, not 40.
    expect(misses).toBe(0);
  });

  it("starts counting from zero once the lockout expires", () => {
    // Exactly the situation that failed: many lockout misses, then the lockout ends.
    let misses = 0;
    for (let i = 0; i < 35; i++) {
      misses = assessMiss({ now: lockoutUntil - 1, lockoutUntil, misses, lostAfter }).misses;
    }
    const first = assessMiss({ now: lockoutUntil, lockoutUntil, misses, lostAfter });
    expect(first.lockedOut).toBe(false);
    expect(first.misses).toBe(1);
    expect(first.giveUp).toBe(false);
  });

  it("gives up only after lostAfter consecutive post-lockout misses", () => {
    let misses = 0;
    const results = [];
    for (let i = 0; i < lostAfter; i++) {
      const r = assessMiss({ now: lockoutUntil + 1, lockoutUntil, misses, lostAfter });
      misses = r.misses;
      results.push(r.giveUp);
    }
    expect(results).toEqual([false, false, false, false, true]);
  });

  it("re-arming the lockout after an unapproved push resets the danger", () => {
    // Simulates: push sent, not approved, lockoutUntil pushed forward again.
    const rearmed = lockoutUntil + 25 * 60_000;
    const r = assessMiss({ now: lockoutUntil + 1, lockoutUntil: rearmed, misses: 4, lostAfter });
    expect(r.lockedOut).toBe(true);
    expect(r.misses).toBe(0);
    expect(r.giveUp).toBe(false);
  });
});
