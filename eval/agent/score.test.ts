import { describe, expect, it } from "vitest";
import { scoreAnswer, summarize, taskValue, type RunMetrics } from "./score.js";

const m = (toolCalls: number, tokens: number, seconds: number, score: number): RunMetrics => ({
  toolCalls,
  tokens,
  seconds,
  score,
});

describe("scoreAnswer", () => {
  it("is the share of mustMention present, case-insensitive", () => {
    expect(scoreAnswer("Calls FooBar and baz", ["foobar", "BAZ", "qux", "zip"])).toBe(0.5);
  });

  it("compares paths with / regardless of separator", () => {
    expect(scoreAnswer("see src\\search\\graph.ts", ["src/search/graph.ts"])).toBe(1);
    expect(scoreAnswer("see src/search/graph.ts", ["src\\search\\graph.ts"])).toBe(1);
  });

  it("is 0 when nothing matches", () => {
    expect(scoreAnswer("nothing", ["a"])).toBe(0);
  });
});

describe("taskValue", () => {
  it("takes the median per metric for an odd number of runs", () => {
    expect(taskValue([m(10, 300, 5, 1), m(2, 100, 9, 0), m(4, 200, 1, 0.5)])).toEqual(m(4, 200, 5, 0.5));
  });

  it("averages the two central values for an even number of runs", () => {
    expect(taskValue([m(1, 100, 2, 0), m(3, 300, 4, 1), m(9, 900, 8, 1), m(5, 500, 6, 0)])).toEqual(m(4, 400, 5, 0.5));
  });
});

describe("summarize", () => {
  it("uses median for calls/tokens/seconds and mean for score, diverging on an outlier", () => {
    const s = summarize([m(2, 100, 1, 1), m(3, 120, 2, 1), m(100, 9000, 50, 0)]);
    expect(s.toolCalls).toBe(3);
    expect(s.tokens).toBe(120);
    expect(s.seconds).toBe(2);
    expect(s.score).toBeCloseTo(2 / 3);
  });
});
