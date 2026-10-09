import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  descendants,
  evaluate,
  allPassed,
  parsePs,
  percentile,
  rssLimitMb,
  searchShares,
  treeRss,
  type Latency,
  type VerdictInput,
} from "./real-model-report";

const PS = `  1     0  1000
 10     1  5000
 11    10  2000000
 12    11  300
 20     1  7000
 garbage line
`;

function okInput(over: Partial<VerdictInput> = {}): VerdictInput {
  const fast: Latency = { ms: 100, indexing: true, partial: false };
  return {
    model: "qwen3-embedding-0.6b",
    minEmbedded: 300,
    chunks: 5000,
    embedded: 5000,
    exitedBeforeShutdown: null,
    errors: [],
    rss: { supported: true, peakTotalKb: 2_000_000, peakRootKb: 400_000, peakChildKb: 1_600_000, rootPeakPhase: "vector" },
    status: [5, 8, 12],
    lexical: [{ ms: 10, indexing: true }],
    hybrid: [fast],
    similar: [fast],
    nr07Ms: 300,
    shutdown: { exitMs: 200, leftover: 0 },
    ...over,
  };
}

const failed = (checks: ReturnType<typeof evaluate>) => checks.filter((c) => c.status === "fail").map((c) => c.name);

describe("percentile", () => {
  it("uses nearest rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
  });
});

describe("ps parsing", () => {
  it("parses rows and skips garbage", () => {
    expect(parsePs(PS)).toHaveLength(5);
    expect(parsePs(PS)[2]).toEqual({ pid: 11, ppid: 10, rssKb: 2000000 });
  });

  it("finds descendants transitively and excludes siblings", () => {
    expect(descendants(parsePs(PS), 10).sort()).toEqual([11, 12]);
    expect(descendants(parsePs(PS), 12)).toEqual([]);
  });

  it("sums RSS over the tree", () => {
    const t = treeRss(parsePs(PS), 10);
    expect(t.rootKb).toBe(5000);
    expect(t.childrenKb).toBe(2000300);
    expect(t.totalKb).toBe(2005300);
    expect(t.pids).toEqual([10, 11, 12]);
  });

  it("handles a missing root", () => {
    expect(treeRss(parsePs(PS), 999).totalKb).toBe(0);
  });
});

describe("thresholds", () => {
  it("picks the RSS limit by model", () => {
    expect(rssLimitMb("qwen3-embedding-0.6b")).toBe(2560);
    expect(rssLimitMb("bge-m3")).toBe(1024);
    expect(rssLimitMb("multilingual-e5-small")).toBe(1024);
  });
});

describe("evaluate", () => {
  it("passes a healthy run", () => {
    const checks = evaluate(okInput());
    expect(failed(checks)).toEqual([]);
    expect(allPassed(checks)).toBe(true);
  });

  it("fails on early exit and fatal errors", () => {
    expect(failed(evaluate(okInput({ exitedBeforeShutdown: { code: null, signal: "SIGTRAP" } })))).toEqual(["no-crash"]);
    expect(
      failed(evaluate(okInput({ errors: ["embedding provider unavailable: local inference process exited (signal SIGABRT)"] }))),
    ).toEqual(["no-crash"]);
    expect(failed(evaluate(okInput({ errors: ["some other warning"] })))).toEqual([]);
  });

  it("requires min(minEmbedded, chunks) embedded", () => {
    expect(failed(evaluate(okInput({ embedded: 299, chunks: 5000 })))).toEqual(["progress"]);
    expect(failed(evaluate(okInput({ embedded: 120, chunks: 120 })))).toEqual([]);
    expect(failed(evaluate(okInput({ embedded: 0, chunks: 0 })))).toEqual(["progress"]);
  });

  it("gates RSS by model and skips when unsupported", () => {
    const rss = (kb: number) => ({ supported: true, peakTotalKb: kb, peakRootKb: 1, peakChildKb: 1, rootPeakPhase: null });
    expect(failed(evaluate(okInput({ rss: rss(2561 * 1024) })))).toEqual(["rss"]);
    expect(failed(evaluate(okInput({ rss: rss(2560 * 1024) })))).toEqual([]);
    expect(failed(evaluate(okInput({ model: "multilingual-e5-small", rss: rss(1025 * 1024) })))).toEqual(["rss"]);
    const skipped = evaluate(okInput({ rss: { supported: false, peakTotalKb: 0, peakRootKb: 0, peakChildKb: 0, rootPeakPhase: null } }));
    expect(skipped.find((c) => c.name === "rss")?.status).toBe("skip");
    expect(allPassed(skipped)).toBe(true);
  });

  it("gates status, lexical and NR-07", () => {
    expect(failed(evaluate(okInput({ status: [10, 10, 250] })))).toEqual(["status-p95"]);
    expect(failed(evaluate(okInput({ lexical: [{ ms: 201, indexing: true }] })))).toEqual(["lexical-p95"]);
    expect(failed(evaluate(okInput({ nr07Ms: THRESHOLDS.nr07Ms + 1 })))).toEqual(["nr07"]);
    expect(failed(evaluate(okInput({ nr07Ms: null })))).toEqual(["nr07"]);
  });

  it("requires slow search responses to be partial with timed out", () => {
    const slowPartial: Latency = { ms: 1000, indexing: true, partial: true, partialReason: "query embedding timed out" };
    expect(failed(evaluate(okInput({ hybrid: [slowPartial] })))).toEqual([]);
    const slowFull: Latency = { ms: 900, indexing: true, partial: false };
    expect(failed(evaluate(okInput({ hybrid: [slowFull] })))).toEqual(["hybrid-during-indexing"]);
    const slowOtherPartial: Latency = { ms: 900, indexing: true, partial: true, partialReason: "vectors incomplete" };
    expect(failed(evaluate(okInput({ similar: [slowOtherPartial] })))).toEqual(["find-similar-during-indexing"]);
    const tooSlow: Latency = { ms: 1301, indexing: true, partial: true, partialReason: "timed out" };
    expect(failed(evaluate(okInput({ hybrid: [tooSlow] })))).toEqual(["hybrid-during-indexing"]);
  });

  it("ignores search samples taken outside indexing", () => {
    const after: Latency = { ms: 5000, indexing: false };
    const checks = evaluate(okInput({ hybrid: [after] }));
    expect(checks.find((c) => c.name === "hybrid-during-indexing")?.status).toBe("skip");
  });

  it("gates shutdown", () => {
    expect(failed(evaluate(okInput({ shutdown: { exitMs: null, leftover: 0 } })))).toEqual(["shutdown"]);
    expect(failed(evaluate(okInput({ shutdown: { exitMs: 100, leftover: 1 } })))).toEqual(["shutdown"]);
    expect(failed(evaluate(okInput({ shutdown: { exitMs: 10_001, leftover: 0 } })))).toEqual(["shutdown"]);
  });
});

describe("searchShares", () => {
  it("computes semantic and timed out shares", () => {
    const s = searchShares([
      { ms: 1, indexing: true, partial: false },
      { ms: 1, indexing: true, partial: true, partialReason: "embedding timed out" },
      { ms: 1, indexing: true, partial: true, partialReason: "other" },
      { ms: 1, indexing: true, partial: false },
    ]);
    expect(s.semanticShare).toBe(0.5);
    expect(s.timedOutShare).toBe(0.25);
  });
});
