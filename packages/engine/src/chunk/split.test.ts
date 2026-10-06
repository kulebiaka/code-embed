import { describe, expect, it } from "vitest";
import { splitText } from "./split";
import type { ChunkOptions } from "./types";

const opts = (maxTokens: number, overlapRatio = 0.15): ChunkOptions => ({
  maxTokens,
  overlapRatio,
  countTokens: (s) => Math.ceil(s.length / 4),
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line number ${String(i).padStart(3, "0")}`).join("\n");

describe("splitText", () => {
  it("returns one range for text that fits", () => {
    const t = lines(3);
    expect(splitText(t, opts(100))).toEqual([{ start: 0, end: t.length }]);
  });

  it("cuts on line boundaries within the limit and covers the whole text", () => {
    const t = lines(100);
    const o = opts(50);
    const ranges = splitText(t, o);
    expect(ranges.length).toBeGreaterThan(5);
    for (const r of ranges) expect(o.countTokens(t.slice(r.start, r.end))).toBeLessThanOrEqual(50);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges.at(-1)!.end).toBe(t.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.start).toBeLessThanOrEqual(ranges[i - 1]!.end);
  });

  it("overlaps neighbours by about overlapRatio of maxTokens", () => {
    const t = lines(100);
    const o = opts(100, 0.15);
    const ranges = splitText(t, o);
    for (let i = 1; i < ranges.length - 1; i++) {
      const overlap = o.countTokens(t.slice(ranges[i]!.start, ranges[i - 1]!.end));
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(15);
    }
  });

  it("has no overlap when ratio is 0", () => {
    const t = lines(60);
    const ranges = splitText(t, opts(50, 0));
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.start).toBe(ranges[i - 1]!.end);
  });

  it("hard-cuts a single line longer than the limit", () => {
    const t = "a".repeat(1000);
    const o = opts(50);
    const ranges = splitText(t, o);
    expect(ranges.length).toBe(5);
    for (const r of ranges) expect(o.countTokens(t.slice(r.start, r.end))).toBeLessThanOrEqual(50);
    expect(ranges.map((r) => r.end - r.start).reduce((a, b) => a + b)).toBe(1000);
  });

  it("does not split surrogate pairs when hard-cutting", () => {
    const t = "😀".repeat(200);
    for (const r of splitText(t, opts(20))) {
      const s = t.slice(r.start, r.end);
      expect(s.length % 2).toBe(0);
    }
  });

  it("terminates with a huge line between normal ones", () => {
    const t = `${lines(10)}\n${"x".repeat(500)}\n${lines(10)}`;
    const ranges = splitText(t, opts(40));
    expect(ranges.at(-1)!.end).toBe(t.length);
    expect(ranges.length).toBeLessThan(40);
  });
});
