import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  descendants,
  evaluate,
  allPassed,
  inferenceProcesses,
  newPeaks,
  parsePs,
  percentile,
  recordSample,
  rssLimitMb,
  searchShares,
  splitRss,
  strayInference,
  treeRss,
  type EngineObs,
  type HostObs,
  type Latency,
  type MachineInput,
} from "./real-model-report";

const PS = `  1     0  1000
 10     1  5000
 11    10  2000000
 12    11  300
 20     1  7000
 garbage line
`;

const MB = 1024;

function engine(over: Partial<EngineObs> = {}): EngineObs {
  const fast: Latency = { ms: 100, indexing: true, partial: false };
  return {
    chunks: 5000,
    embedded: 5000,
    exitedBeforeShutdown: null,
    errors: [],
    rss: { peakTreeKb: 500 * MB, peakEngineKb: 400 * MB, peakChildKb: 100 * MB, peakPhase: "vector" },
    status: [5, 8, 12],
    lexical: [{ ms: 10, indexing: true }],
    hybrid: [fast],
    similar: [fast],
    nr07Ms: 300,
    shutdown: { exitMs: 200, leftover: 0 },
    ...over,
  };
}

function okInput(over: Partial<MachineInput> = {}): MachineInput {
  return { model: "qwen3-embedding-0.6b", minEmbedded: 300, rssSupported: true, engines: [engine()], host: null, ...over };
}

function host(over: Partial<HostObs> = {}): HostObs {
  return { firstPid: 50, pid: 50, peakTreeKb: 1800 * MB, shutdown: { exitMs: 300, leftover: 0 }, ...over };
}

const treeEngine = (peakTreeMb: number, peakEngineMb: number): EngineObs =>
  engine({ rss: { peakTreeKb: peakTreeMb * MB, peakEngineKb: peakEngineMb * MB, peakChildKb: 0, peakPhase: null } });

const failed = (checks: ReturnType<typeof evaluate>) => checks.filter((c) => c.status === "fail").map((c) => c.name);
const statusOf = (checks: ReturnType<typeof evaluate>, name: string) => checks.find((c) => c.name === name)?.status;
const one = (e: Partial<EngineObs>, extra: Partial<MachineInput> = {}) => okInput({ engines: [engine(e)], ...extra });

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
    expect(checks.map((c) => c.name)).toEqual([
      "no-crash",
      "progress",
      "status-p95",
      "lexical-p95",
      "nr07",
      "hybrid-during-indexing",
      "find-similar-during-indexing",
      "shutdown",
      "rss",
      "rss-host",
      "shutdown-host",
    ]);
  });

  it("fails on early exit and fatal errors", () => {
    expect(failed(evaluate(one({ exitedBeforeShutdown: { code: null, signal: "SIGTRAP" } })))).toEqual(["no-crash"]);
    expect(
      failed(evaluate(one({ errors: ["embedding provider unavailable: local inference process exited (signal SIGABRT)"] }))),
    ).toEqual(["no-crash"]);
    expect(failed(evaluate(one({ errors: ["some other warning"] })))).toEqual([]);
  });

  it("requires min(minEmbedded, chunks) embedded", () => {
    expect(failed(evaluate(one({ embedded: 299, chunks: 5000 })))).toEqual(["progress"]);
    expect(failed(evaluate(one({ embedded: 120, chunks: 120 })))).toEqual([]);
    expect(failed(evaluate(one({ embedded: 0, chunks: 0 })))).toEqual(["progress"]);
  });

  it("gates RSS by model and skips when unsupported (no host: the old tree check)", () => {
    const rss = (mbv: number) => ({ rss: { peakTreeKb: mbv * MB, peakEngineKb: MB, peakChildKb: MB, peakPhase: null } });
    expect(failed(evaluate(one(rss(2561))))).toEqual(["rss"]);
    expect(failed(evaluate(one(rss(2560))))).toEqual([]);
    expect(failed(evaluate(one(rss(1025), { model: "multilingual-e5-small" })))).toEqual(["rss"]);
    const skipped = evaluate(okInput({ rssSupported: false }));
    expect(statusOf(skipped, "rss")).toBe("skip");
    expect(statusOf(skipped, "rss-host")).toBe("skip");
    expect(allPassed(skipped)).toBe(true);
  });

  it("n = 1 with a host: host + engine tree <= limit", () => {
    const at = (h: number, e: number) => okInput({ engines: [treeEngine(e, 300)], host: host({ peakTreeKb: h * MB }) });
    expect(failed(evaluate(at(2000, 560)))).toEqual([]);
    expect(failed(evaluate(at(2000, 561)))).toEqual(["rss"]);
    expect(evaluate(at(2000, 560)).find((c) => c.name === "rss")?.detail).toContain("host 2000 MB + engine tree 560 MB = 2560 MB");
  });

  it("n > 1: host + sum of engine trees <= limit + n x max engine", () => {
    const engines = (tree: number, last = tree) => [treeEngine(tree, 400), treeEngine(tree, 300), treeEngine(last, 200)];
    // limit 2560 + 3 * 400 = 3760; host 1800 + 650 + 650 + 660 = 3760
    expect(failed(evaluate(okInput({ engines: engines(650, 660), host: host() })))).toEqual([]);
    expect(failed(evaluate(okInput({ engines: engines(650, 661), host: host() })))).toEqual(["rss"]);
    const detail = evaluate(okInput({ engines: engines(650, 660), host: host() })).find((c) => c.name === "rss")!.detail;
    expect(detail).toContain("3 x max engine 400 MB = 3760");
    expect(detail).toContain("[650 + 650 + 660]");
  });

  it("n > 1 without a host uses the same formula with a zero host", () => {
    expect(failed(evaluate(okInput({ engines: [treeEngine(1700, 500), treeEngine(1860, 500)] })))).toEqual([]);
    expect(failed(evaluate(okInput({ engines: [treeEngine(1700, 500), treeEngine(1861, 500)] })))).toEqual(["rss"]);
  });

  it("rss-host: pass, fail and skip", () => {
    expect(statusOf(evaluate(okInput({ host: host({ peakTreeKb: 2560 * MB }) })), "rss-host")).toBe("pass");
    expect(statusOf(evaluate(okInput({ host: host({ peakTreeKb: 2561 * MB }) })), "rss-host")).toBe("fail");
    expect(statusOf(evaluate(okInput({ host: null })), "rss-host")).toBe("skip");
    expect(statusOf(evaluate(okInput({ model: "bge-m3", host: host({ peakTreeKb: 1025 * MB }) })), "rss-host")).toBe("fail");
  });

  it("gates status, lexical and NR-07", () => {
    expect(failed(evaluate(one({ status: [10, 10, 250] })))).toEqual(["status-p95"]);
    expect(failed(evaluate(one({ lexical: [{ ms: 201, indexing: true }] })))).toEqual(["lexical-p95"]);
    expect(failed(evaluate(one({ nr07Ms: THRESHOLDS.nr07Ms + 1 })))).toEqual(["nr07"]);
    expect(failed(evaluate(one({ nr07Ms: null })))).toEqual(["nr07"]);
  });

  it("requires slow search responses to be partial with timed out", () => {
    const slowPartial: Latency = { ms: 1000, indexing: true, partial: true, partialReason: "query embedding timed out" };
    expect(failed(evaluate(one({ hybrid: [slowPartial] })))).toEqual([]);
    const slowFull: Latency = { ms: 900, indexing: true, partial: false };
    expect(failed(evaluate(one({ hybrid: [slowFull] })))).toEqual(["hybrid-during-indexing"]);
    const slowOtherPartial: Latency = { ms: 900, indexing: true, partial: true, partialReason: "vectors incomplete" };
    expect(failed(evaluate(one({ similar: [slowOtherPartial] })))).toEqual(["find-similar-during-indexing"]);
    const tooSlow: Latency = { ms: 1301, indexing: true, partial: true, partialReason: "timed out" };
    expect(failed(evaluate(one({ hybrid: [tooSlow] })))).toEqual(["hybrid-during-indexing"]);
  });

  it("ignores search samples taken outside indexing", () => {
    const after: Latency = { ms: 5000, indexing: false };
    expect(statusOf(evaluate(one({ hybrid: [after] })), "hybrid-during-indexing")).toBe("skip");
  });

  it("gates engine shutdown", () => {
    expect(failed(evaluate(one({ shutdown: { exitMs: null, leftover: 0 } })))).toEqual(["shutdown"]);
    expect(failed(evaluate(one({ shutdown: { exitMs: 100, leftover: 1 } })))).toEqual(["shutdown"]);
    expect(failed(evaluate(one({ shutdown: { exitMs: 10_001, leftover: 0 } })))).toEqual(["shutdown"]);
    expect(failed(evaluate(one({ shutdown: { exitMs: 10_000, leftover: 0 } })))).toEqual([]);
  });

  it("gates host shutdown: pass, fail and skip", () => {
    const sd = (shutdown: HostObs["shutdown"]) => evaluate(okInput({ host: host({ shutdown }) }));
    expect(statusOf(sd({ exitMs: 10_000, leftover: 0 }), "shutdown-host")).toBe("pass");
    expect(statusOf(sd({ exitMs: 10_001, leftover: 0 }), "shutdown-host")).toBe("fail");
    expect(statusOf(sd({ exitMs: null, leftover: 2 }), "shutdown-host")).toBe("fail");
    expect(statusOf(sd({ exitMs: 100, leftover: 1 }), "shutdown-host")).toBe("fail");
    expect(statusOf(evaluate(okInput()), "shutdown-host")).toBe("skip");
  });

  it("fails no-crash when the host restarted", () => {
    const checks = evaluate(okInput({ host: host({ firstPid: 50, pid: 77 }) }));
    expect(failed(checks)).toEqual(["no-crash"]);
    expect(checks.find((c) => c.name === "no-crash")?.detail).toContain("host restarted: 50 → 77");
  });

  it("keeps plain names for one engine and prefixes p<i>: for several", () => {
    const single = evaluate(okInput({ host: host() })).map((c) => c.name);
    expect(single).toContain("shutdown");
    expect(single.some((n) => n.startsWith("p1:"))).toBe(false);

    const multi = evaluate(okInput({ engines: [engine(), engine(), engine()], host: host() })).map((c) => c.name);
    for (const i of [1, 2, 3]) {
      for (const base of [
        "no-crash",
        "progress",
        "status-p95",
        "lexical-p95",
        "nr07",
        "hybrid-during-indexing",
        "find-similar-during-indexing",
        "shutdown",
      ])
        expect(multi).toContain(`p${i}:${base}`);
    }
    expect(multi).toEqual(expect.arrayContaining(["rss", "rss-host", "shutdown-host"]));
    expect(multi).not.toContain("shutdown");
  });

  it("attributes a failing engine to its prefix", () => {
    const checks = evaluate(okInput({ engines: [engine(), engine({ status: [300] }), engine()], host: host() }));
    expect(failed(checks)).toEqual(["p2:status-p95"]);
  });

  it("n > 1: host restart is a machine-level no-crash failure", () => {
    const checks = evaluate(okInput({ engines: [engine(), engine()], host: host({ firstPid: 1, pid: 2 }) }));
    expect(failed(checks)).toEqual(["no-crash"]);
  });
});

describe("splitRss", () => {
  const ps = (rows: [number, number, number][]) => rows.map(([pid, ppid, rssKb]) => ({ pid, ppid, rssKb }));

  it("host as a child of the first engine is subtracted from that engine tree", () => {
    const entries = ps([
      [1, 0, 100],
      [10, 1, 400],
      [11, 10, 50],
      [20, 10, 100],
      [21, 20, 1500],
      [30, 1, 300],
    ]);
    const s = splitRss(entries, [10, 30], 20);
    expect(s.host).toMatchObject({ totalKb: 1600, rootKb: 100, childrenKb: 1500, pids: [20, 21] });
    expect(s.engines[0]).toMatchObject({ totalKb: 450, rootKb: 400, childrenKb: 50, pids: [10, 11] });
    expect(s.engines[1]).toMatchObject({ totalKb: 300, rootKb: 300, childrenKb: 0, pids: [30] });
  });

  it("an orphaned host (ppid 1) is counted once and engines are untouched", () => {
    const entries = ps([
      [1, 0, 100],
      [10, 1, 400],
      [11, 10, 50],
      [20, 1, 100],
      [21, 20, 1500],
    ]);
    const s = splitRss(entries, [10], 20);
    expect(s.host?.totalKb).toBe(1600);
    expect(s.engines[0]?.totalKb).toBe(450);
  });

  it("without a host it equals treeRss", () => {
    const entries = parsePs(PS);
    for (const hostPid of [null, 999]) {
      const s = splitRss(entries, [10], hostPid);
      expect(s.host).toBeNull();
      expect(s.engines[0]).toEqual(treeRss(entries, 10));
    }
  });

  it("tracks peaks per engine and for the host", () => {
    const peaks = newPeaks(2);
    const e1 = ps([
      [10, 1, 400],
      [20, 10, 1000],
      [30, 1, 200],
    ]);
    recordSample(peaks, splitRss(e1, [10, 30], 20), 20, ["vector", "idle"]);
    const e2 = ps([
      [10, 1, 600],
      [11, 10, 70],
      [20, 1, 900],
      [30, 1, 100],
    ]);
    recordSample(peaks, splitRss(e2, [10, 30], 20), 20, ["lexical", "idle"]);
    expect(peaks.hostKb).toBe(1000);
    expect(peaks.totalKb).toBe(1670);
    expect(peaks.hostFirstPid).toBe(20);
    expect(peaks.hostPids).toEqual([20]);
    expect(peaks.engines[0]).toEqual({ treeKb: 670, engineKb: 600, childKb: 70, phase: "lexical" });
    expect(peaks.engines[1]).toEqual({ treeKb: 200, engineKb: 200, childKb: 0, phase: "idle" });
  });
});

describe("strayInference", () => {
  it("finds this run's host and workers by command line only", () => {
    const cli = "/tmp/real-model-vsix-x/unpacked/extension/dist/engine/cli.js";
    const ps = [
      `  101 /Applications/Code Helper (Plugin) ${cli} __embed-host`,
      `  102 /Applications/Code Helper (Plugin) ${cli} __embed-worker`,
      `  103 /Applications/Code Helper (Plugin) ${cli} serve`,
      `  104 /Applications/Code Helper (Plugin) /Users/me/.vscode/extensions/code-embed/dist/engine/cli.js __embed-worker`,
      `  105 /bin/zsh -c grep __embed-host`,
      "garbage",
    ].join("\n");
    expect(strayInference(ps, cli)).toEqual([101, 102]);
  });
});

describe("inferenceProcesses", () => {
  const cli = "/tmp/real-model-x/cli.js";
  const row = (pid: number, ppid: number, command: string) => `  ${pid} ${ppid} ${command}`;
  const engineA = row(10, 1, `/Code Helper ${cli} serve`);
  const host = row(11, 10, `/Code Helper ${cli} __embed-host`);
  const hostWorker = row(12, 11, `/Code Helper ${cli} __embed-worker`);
  const engineB = row(20, 1, `/Code Helper ${cli} serve`);
  const engineWorker = row(21, 20, `/Code Helper ${cli} __embed-worker`);
  const foreignWorker = row(22, 20, "/Code Helper /other/cli.js __embed-worker");

  it("counts one worker under the host and none under engines as ok", () => {
    const ps = [engineA, host, hostWorker, engineB].join("\n");
    expect(inferenceProcesses(ps, cli, 11, [10, 20])).toEqual({ hostWorkers: 1, engineWorkers: [] });
  });

  it("counts every worker under the host", () => {
    const ps = [engineA, host, hostWorker, row(13, 11, `/Code Helper ${cli} __embed-worker`)].join("\n");
    expect(inferenceProcesses(ps, cli, 11, [10]).hostWorkers).toBe(2);
  });

  it("reports a worker under an engine, but not the host's own worker under its parent engine", () => {
    const ps = [engineA, host, hostWorker, engineB, engineWorker].join("\n");
    expect(inferenceProcesses(ps, cli, 11, [10, 20])).toEqual({ hostWorkers: 1, engineWorkers: [21] });
  });

  it("ignores workers of other cli.js files", () => {
    const ps = [engineA, host, engineB, foreignWorker].join("\n");
    expect(inferenceProcesses(ps, cli, 11, [10, 20])).toEqual({ hostWorkers: 0, engineWorkers: [] });
  });

  it("without a host every worker under an engine is reported", () => {
    const ps = [engineA, host, hostWorker].join("\n");
    expect(inferenceProcesses(ps, cli, null, [10])).toEqual({ hostWorkers: 0, engineWorkers: [12] });
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
