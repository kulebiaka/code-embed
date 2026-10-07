import { describe, expect, it } from "vitest";
import { aggregate, isHit, metricsOf, percentile, scoreQuery } from "./metrics";
import type { EvalQuery } from "./types";

const q = (id: string, repo: string, lang: "ru" | "en", expected: EvalQuery["expected"]): EvalQuery => ({
  id,
  repo,
  query: id,
  lang,
  expected,
});
const r = (path: string, startLine: number, endLine: number) => ({ path, startLine, endLine });

describe("isHit", () => {
  it("requires the same path and overlapping lines", () => {
    const e = { path: "a.go", startLine: 10, endLine: 20 };
    expect(isHit(e, r("a.go", 20, 30))).toBe(true);
    expect(isHit(e, r("a.go", 1, 10))).toBe(true);
    expect(isHit(e, r("a.go", 21, 30))).toBe(false);
    expect(isHit(e, r("b.go", 10, 20))).toBe(false);
    expect(isHit(e, r("./a.go", 12, 13))).toBe(true);
  });
});

describe("scoreQuery", () => {
  it("computes reciprocal rank of the first hit", () => {
    const query = q("1", "x", "en", [{ path: "a.go", startLine: 10, endLine: 20 }]);
    const s = scoreQuery(query, [r("b.go", 1, 5), r("c.go", 1, 5), r("a.go", 15, 16)]);
    expect(s.rr).toBeCloseTo(1 / 3);
    expect(s.recall).toBe(1);
  });

  it("ignores results beyond the top 10", () => {
    const query = q("1", "x", "en", [{ path: "a.go", startLine: 1, endLine: 2 }]);
    const results = Array.from({ length: 10 }, (_, i) => r(`f${i}.go`, 1, 2));
    results.push(r("a.go", 1, 2));
    expect(scoreQuery(query, results)).toMatchObject({ recall: 0, rr: 0 });
  });

  it("averages found fraction over multiple expected chunks", () => {
    const query = q("1", "x", "en", [
      { path: "a.go", startLine: 1, endLine: 5 },
      { path: "b.go", startLine: 1, endLine: 5 },
    ]);
    const s = scoreQuery(query, [r("b.go", 2, 3)]);
    expect(s.recall).toBe(0.5);
    expect(s.rr).toBe(1);
  });
});

describe("aggregate", () => {
  it("splits by language and repo", () => {
    const a = { path: "a", startLine: 1, endLine: 1 };
    const scores = [
      scoreQuery(q("1", "x", "en", [a]), [r("a", 1, 1)]),
      scoreQuery(q("2", "x", "ru", [a]), [r("z", 1, 1), r("a", 1, 1)]),
      scoreQuery(q("3", "y", "ru", [a]), []),
      scoreQuery(q("4", "y", "en", [a]), [r("a", 1, 1)]),
    ];
    const m = aggregate(scores);
    expect(m.overall).toEqual({ count: 4, recallAt10: 0.75, mrr: (1 + 0.5 + 0 + 1) / 4 });
    expect(m.ru).toEqual({ count: 2, recallAt10: 0.5, mrr: 0.25 });
    expect(m.en).toEqual({ count: 2, recallAt10: 1, mrr: 1 });
    expect(m.perRepo.x).toEqual({ count: 2, recallAt10: 1, mrr: 0.75 });
    expect(m.perRepo.y).toEqual({ count: 2, recallAt10: 0.5, mrr: 0.5 });
  });

  it("returns zeros for an empty set", () => {
    expect(metricsOf([])).toEqual({ count: 0, recallAt10: 0, mrr: 0 });
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const v = [5, 1, 3, 2, 4, 10, 9, 8, 7, 6];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});
