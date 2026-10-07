import { describe, expect, it } from "vitest";
import { runBench } from "./bench";
import type { RunReport, RunResult } from "./report";

const m = (recallAt10: number) => ({ count: 4, recallAt10, mrr: 0.5 });
const result = (model: string, recall: number): RunResult => {
  const hybrid: RunReport = {
    model,
    mode: "hybrid",
    createdAt: "now",
    overall: m(recall),
    ru: m(recall / 2),
    en: m(recall),
    perRepo: {},
    indexSeconds: 4,
    chunksPerSec: 50,
    rssMb: 300,
    latencyMs: { p50: 2, p95: 5 },
  };
  return { model, createdAt: "now", reports: [hybrid], nr10: null };
};

describe("runBench", () => {
  it("collects one row per model and survives failures", async () => {
    const seen: string[][] = [];
    const rows = await runBench(["a", "b"], ["--fake"], async (model, args) => {
      seen.push(args);
      if (model === "b") throw new Error("boom");
      return result(model, 0.8);
    });
    expect(seen).toEqual([["--fake"], ["--fake"]]);
    expect(rows[0]).toMatchObject({ model: "a", recall: 0.8, recallRu: 0.4, chunksPerSec: 50, rssMb: 300, p50: 2, p95: 5 });
    expect(rows[1]).toEqual({ model: "b", error: "boom" });
  });
});
