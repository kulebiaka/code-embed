import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type RunReport, benchRow, checkNr10, renderBenchMarkdown, renderMarkdown, writeOutputs } from "./report";
import type { EvalMode } from "./types";

const m = (recallAt10: number, mrr = 0.5, count = 10) => ({ count, recallAt10, mrr });
const rep = (mode: EvalMode, recall: number): RunReport => ({
  model: "fake",
  mode,
  createdAt: "2026-01-01T00:00:00.000Z",
  overall: m(recall),
  ru: m(recall / 2),
  en: m(recall),
  perRepo: { cobra: m(recall) },
  indexSeconds: 2,
  chunksPerSec: 100,
  rssMb: 512,
  latencyMs: { p50: 3, p95: 9 },
});

describe("checkNr10", () => {
  it("passes when hybrid is at least the best of the others", () => {
    const n = checkNr10([rep("lexical", 0.6), rep("semantic", 0.7), rep("hybrid", 0.7)]);
    expect(n).toMatchObject({ ok: true, hybrid: 0.7 });
  });

  it("fails when hybrid is below the best", () => {
    expect(checkNr10([rep("lexical", 0.8), rep("semantic", 0.7), rep("hybrid", 0.75)])?.ok).toBe(false);
  });

  it("is null without all three modes", () => {
    expect(checkNr10([rep("hybrid", 0.7)])).toBeNull();
  });
});

describe("renderMarkdown", () => {
  const reports = [rep("lexical", 0.6), rep("semantic", 0.7), rep("hybrid", 0.8)];
  const md = renderMarkdown({ model: "fake", createdAt: "now", reports, nr10: checkNr10(reports) });

  it("includes metrics, repos and the NR-10 verdict", () => {
    expect(md).toContain("| hybrid | все | 10 | 0.800 | 0.500 |");
    expect(md).toContain("| hybrid | cobra |");
    expect(md).toContain("NR-10 выполняется");
    expect(md).toContain("p95 9.0 мс");
  });
});

describe("bench", () => {
  it("builds rows from the hybrid report and renders errors", () => {
    const row = benchRow("fake", [rep("lexical", 0.1), rep("hybrid", 0.8)]);
    expect(row).toMatchObject({ model: "fake", recall: 0.8, recallRu: 0.4, chunksPerSec: 100, p95: 9 });
    const md = renderBenchMarkdown([row, { model: "bad", error: "download | failed" }], "now");
    expect(md).toContain("| fake | 2.0 | 100.0 | 512 | 3.0 | 9.0 | 0.800 | 0.400 | 0.500 | 0.500 |");
    expect(md).toContain("| bad | ошибка: download / failed |");
  });
});

describe("writeOutputs", () => {
  it("writes json and markdown files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "report-"));
    try {
      const out = writeOutputs(path.join(dir, "nested"), "x", { a: 1 }, "# hi\n");
      expect(JSON.parse(readFileSync(out.json, "utf8"))).toEqual({ a: 1 });
      expect(readFileSync(out.md, "utf8")).toBe("# hi\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
