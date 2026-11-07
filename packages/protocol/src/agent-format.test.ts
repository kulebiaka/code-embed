import { describe, expect, it } from "vitest";
import {
  ToolInputError,
  formatContextForAgent,
  formatForAgent,
  formatOutlineForAgent,
  formatReferencesForAgent,
  toContextParams,
  toFindSimilarParams,
  toOutlineParams,
  toReferencesParams,
  toSearchParams,
} from "./agent-format";
import type { ContextChunk, ReferenceItem, SearchResponse, SearchResult } from "./rpc";

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

const rng = (a: number, b: number) => ({ startLine: a, endLine: b, startByte: 0, endByte: 0 });

describe("toOutlineParams / toReferencesParams", () => {
  it("accepts valid input", () => {
    expect(toOutlineParams({ path: "src/a.ts" })).toEqual({ path: "src/a.ts" });
    expect(toReferencesParams({ symbol: "foo" })).toEqual({ symbol: "foo" });
    expect(toReferencesParams({ symbol: "foo", path: "src/a.ts" })).toEqual({ symbol: "foo", path: "src/a.ts" });
  });

  it("rejects empty or missing values", () => {
    expect(() => toOutlineParams({ path: "" })).toThrow(ToolInputError);
    expect(() => toOutlineParams({} as never)).toThrow(ToolInputError);
    expect(() => toReferencesParams({ symbol: " " })).toThrow(ToolInputError);
    expect(() => toReferencesParams({ symbol: "a", path: "" })).toThrow(ToolInputError);
  });
});

describe("toContextParams", () => {
  it("maps path+line and query, budget_tokens to budgetTokens", () => {
    expect(toContextParams({ path: "a.ts", line: 3 })).toEqual({ path: "a.ts", line: 3 });
    expect(toContextParams({ path: "a.ts", line: 3, budget_tokens: 500 })).toEqual({ path: "a.ts", line: 3, budgetTokens: 500 });
    expect(toContextParams({ query: "retry", budget_tokens: 9 })).toEqual({ query: "retry", budgetTokens: 9 });
  });

  it("rejects invalid input", () => {
    expect(() => toContextParams({ path: "", line: 1 })).toThrow(ToolInputError);
    expect(() => toContextParams({ path: "a.ts", line: 0 })).toThrow(ToolInputError);
    expect(() => toContextParams({ path: "a.ts", line: 1.5 })).toThrow(ToolInputError);
    expect(() => toContextParams({ path: "a.ts" } as never)).toThrow(ToolInputError);
    expect(() => toContextParams({ path: "a.ts", line: 1, query: "q" } as never)).toThrow(ToolInputError);
    expect(() => toContextParams({ query: "" } as never)).toThrow(ToolInputError);
    expect(() => toContextParams({} as never)).toThrow(ToolInputError);
    expect(() => toContextParams({ query: "q", budget_tokens: 0 })).toThrow(ToolInputError);
    expect(() => toContextParams({ query: "q", budget_tokens: 1.5 })).toThrow(ToolInputError);
  });
});

describe("formatOutlineForAgent", () => {
  it("prints path then one row per symbol", () => {
    const text = formatOutlineForAgent({
      path: "src/a.ts",
      lang: "typescript",
      tookMs: 1,
      symbols: [
        { symbol: "A", parentSymbol: null, kind: "class", signature: "class A", range: rng(1, 9) },
        { symbol: "run", parentSymbol: "A", kind: "method", signature: "run(x: number): void", range: rng(2, 4) },
      ],
    });
    expect(text.split("\n")).toEqual(["src/a.ts", "  1-9  class  A  class A", "  2-4  method  A.run  run(x: number): void"]);
  });

  it("handles an empty outline", () => {
    expect(formatOutlineForAgent({ path: "x.md", lang: null, symbols: [], tookMs: 1 })).toContain("No symbols");
  });
});

describe("formatReferencesForAgent", () => {
  const item = (role: "definition" | "usage", line: number, conf: "high" | "low" = "high"): ReferenceItem => ({
    role,
    path: "src/a.ts",
    lang: "typescript",
    range: rng(line, line + 1),
    line,
    symbol: "caller",
    kind: role === "definition" ? "function" : "call",
    confidence: conf,
    text: role === "definition" ? "function foo()" : "  foo(1);",
  });

  it("lists definitions then usages with confidence", () => {
    const text = formatReferencesForAgent({
      symbol: "foo",
      items: [item("definition", 1), item("usage", 10, "low")],
      truncated: false,
      tookMs: 1,
    });
    expect(text.indexOf("Definitions of foo (1)")).toBeLessThan(text.indexOf("Usages (1)"));
    expect(text).toContain("src/a.ts:10  [call, low]");
    expect(text).toContain("foo(1);");
    expect(text).not.toContain("truncated");
  });

  it("marks truncation and applies maxTokens", () => {
    const usages = Array.from({ length: 50 }, (_, i) => item("usage", i + 10));
    const text = formatReferencesForAgent({ symbol: "foo", items: [item("definition", 1), ...usages], truncated: true, tookMs: 1 }, { maxTokens: 100 });
    expect(text).toMatch(/… \d+ more usages/);
    expect(text).toContain("Usage list truncated at the store limit.");
    expect(text).not.toContain("path");
  });

  it("reports nothing found", () => {
    expect(formatReferencesForAgent({ symbol: "zzz", items: [], truncated: false, tookMs: 1 })).toContain("No definitions");
  });
});

describe("formatContextForAgent", () => {
  const chunk = (level: ContextChunk["level"], text: string, confidence?: "high" | "low"): ContextChunk => ({
    level,
    path: `${level}.ts`,
    lang: "typescript",
    range: rng(1, 2),
    symbol: level,
    kind: "function",
    text,
    tokens: 5,
    ...(confidence ? { confidence } : {}),
  });

  it("emits level sections in order, commits, omitted and no truncation", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const text = formatContextForAgent({
      chunks: [chunk("target", long), chunk("caller", "c()", "low"), chunk("callee", "d()", "high")],
      commits: ["abc1234 2026-01-01 init"],
      budgetTokens: 4000,
      usedTokens: 30,
      omitted: ["similar", "lexical"],
      partial: true,
      partialReason: "vectors not ready",
      tookMs: 1,
    });
    const idx = ["## Target", "## Callees", "## Callers", "## Recent commits"].map((h) => text.indexOf(h));
    expect(idx.every((n) => n >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(text).toContain("line39");
    expect(text).toContain("callee.ts:1-2  callee  (high)");
    expect(text).toContain("caller.ts:1-2  caller  (low)");
    expect(text).toContain("abc1234 2026-01-01 init");
    expect(text).toContain("Omitted (budget): similar, lexical");
    expect(text).toContain("vectors not ready");
  });

  it("reports nothing found", () => {
    const text = formatContextForAgent({ chunks: [], commits: [], budgetTokens: 4000, usedTokens: 0, omitted: [], partial: true, tookMs: 1 });
    expect(text).toContain("Nothing found.");
  });
});
