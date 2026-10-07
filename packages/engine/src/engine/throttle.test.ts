import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttleLatest } from "./throttle";

describe("throttleLatest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits at most twice per second and keeps the latest value", () => {
    const seen: number[] = [];
    const t = throttleLatest<number>((v) => seen.push(v), 500);
    for (let i = 0; i < 100; i++) {
      t.push(i);
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(1000);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(99);
    expect(seen.length).toBeLessThanOrEqual(4);
    t.dispose();
  });

  it("emits immediately when idle for the whole interval", () => {
    const seen: number[] = [];
    const t = throttleLatest<number>((v) => seen.push(v), 500);
    t.push(1);
    vi.advanceTimersByTime(600);
    t.push(2);
    expect(seen).toEqual([1, 2]);
    t.dispose();
  });

  it("drops the pending value on dispose", () => {
    const seen: number[] = [];
    const t = throttleLatest<number>((v) => seen.push(v), 500);
    t.push(1);
    t.push(2);
    t.dispose();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([1]);
  });
});
