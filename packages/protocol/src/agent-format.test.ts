import { describe, expect, it } from "vitest";
import { ToolInputError, formatForAgent, toFindSimilarParams, toSearchParams } from "./agent-format";
import type { SearchResponse, SearchResult } from "./rpc";

function result(path: string, start: number, snippet: string, symbol: string | null = "fn", score = 0.8123): SearchResult {
  return {
    path,
    lang: "typescript",
    range: { startLine: start, endLine: start + 2, startByte: 0, endByte: 0 },
    symbol,
    kind: "function",
    score,
    sources: ["lexical"],
    snippet: { text: snippet, startLine: start, highlights: [] },
  };
}
const resp = (results: SearchResult[], extra: Partial<SearchResponse> = {}): SearchResponse => ({ results, partial: false, tookMs: 1, ...extra });

describe("toSearchParams", () => {
  it("passes valid input through", () => {
    expect(toSearchParams({ query: "retry", mode: "lexical", top: 50, include: ["src/**"], exclude: ["x"], lang: "go" })).toEqual({
      query: "retry",
      mode: "lexical",
      top: 50,
      include: ["src/**"],
      exclude: ["x"],
      lang: "go",
    });
    expect(toSearchParams({ query: "q" })).toEqual({ query: "q" });
  });
  it.each([
    [{ query: "" }],
    [{ query: "  " }],
    [{} as never],
    [{ query: "q", top: 0 }],
    [{ query: "q", top: 51 }],
    [{ query: "q", top: 1.5 }],
    [{ query: "q", mode: "fuzzy" as never }],
    [{ query: "q", include: "src" as never }],
  ])("rejects %j", (input) => {
    expect(() => toSearchParams(input)).toThrow(ToolInputError);
  });
});

describe("toFindSimilarParams", () => {
  it("maps the location form", () => {
    expect(toFindSimilarParams({ path: "a.ts", start_line: 3, end_line: 9, top: 5 })).toEqual({
      path: "a.ts",
      range: { startLine: 3, endLine: 9 },
      top: 5,
    });
  });
  it("maps the code form", () => {
    expect(toFindSimilarParams({ code: "x()", lang: "ts" })).toEqual({ code: "x()", lang: "ts" });
  });
  it.each([
    [{} as never],
    [{ path: "a.ts", start_line: 5, end_line: 2 }],
    [{ path: "a.ts", start_line: 0, end_line: 2 }],
    [{ path: "a.ts", start_line: 1 } as never],
    [{ path: "a.ts", start_line: 1, end_line: 2, code: "x" } as never],
    [{ path: "a.ts", start_line: 1, end_line: 2, lang: "ts" } as never],
    [{ code: "" }],
    [{ code: "x", top: 99 }],
  ])("rejects %j", (input) => {
    expect(() => toFindSimilarParams(input)).toThrow(ToolInputError);
  });
});

describe("formatForAgent", () => {
  it("golden: results with snippets", () => {
    const out = formatForAgent(resp([result("src/a.ts", 10, "line1\nline2\n"), result("src/b.ts", 4, "x", null, 0.5)]));
    expect(out).toBe(["src/a.ts:10-12  fn  (0.81)", "    line1", "    line2", "src/b.ts:4-6  -  (0.50)", "    x"].join("\n"));
  });
  it("golden: partial warning goes first", () => {
    const out = formatForAgent(resp([result("a.ts", 1, "x")], { partial: true, partialReason: "vector indexing 40%" }));
    expect(out.split("\n")[0]).toBe("Warning: the index is incomplete (vector indexing 40%), results may be incomplete.");
    expect(out.split("\n")[1]).toBe("a.ts:1-3  fn  (0.81)");
  });
  it("truncates snippets to 12 lines", () => {
    const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const lines = formatForAgent(resp([result("a.ts", 1, text)])).split("\n");
    expect(lines).toHaveLength(1 + 12 + 1);
    expect(lines[12]).toBe("    l11");
    expect(lines[13]).toBe("    ...");
  });
  it("applies the token limit and reports the rest", () => {
    const text = Array.from({ length: 12 }, () => "x".repeat(100)).join("\n");
    const results = Array.from({ length: 30 }, (_, i) => result(`f${i}.ts`, 1, text));
    const out = formatForAgent(resp(results));
    expect(out.length).toBeLessThanOrEqual(16000 + 40);
    const m = out.match(/… (\d+) more results$/);
    expect(m).not.toBeNull();
    const shown = out.split("\n").filter((l) => /^f\d+\.ts:/.test(l)).length;
    expect(shown + Number(m![1])).toBe(30);
  });
  it("always includes the first result", () => {
    const out = formatForAgent(resp([result("a.ts", 1, "x".repeat(500)), result("b.ts", 1, "y")]), { maxTokens: 10 });
    expect(out).toContain("a.ts:1-3");
    expect(out.endsWith("… 1 more results")).toBe(true);
  });
  it("reports empty results", () => {
    expect(formatForAgent(resp([]))).toBe("Nothing found.");
  });
});
