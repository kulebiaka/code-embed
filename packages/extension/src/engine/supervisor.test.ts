import { describe, expect, it } from "vitest";
import { BACKOFF_MS, CRASH_WINDOW_MS, planRestart } from "./supervisor";

describe("planRestart", () => {
  it("uses backoff 1/2/4 s and fails on the 4th crash in the window", () => {
    let crashes: number[] = [];
    const delays: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      const plan = planRestart(crashes, 1000 + i * 10);
      crashes = plan.crashes;
      delays.push(plan.delayMs);
    }
    expect(delays).toEqual([BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2], undefined]);
  });

  it("forgets crashes older than 5 minutes", () => {
    const old = [0, 1, 2];
    const plan = planRestart(old, CRASH_WINDOW_MS + 10);
    expect(plan.crashes).toEqual([CRASH_WINDOW_MS + 10]);
    expect(plan.delayMs).toBe(1000);
  });
});
