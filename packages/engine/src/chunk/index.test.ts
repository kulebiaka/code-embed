import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkWindows } from "./fallback";
import { chunkFile, hasGrammar, initChunker } from "./index";
import { chunkMarkdown } from "./markdown";
import { chunkWithTreeSitter } from "./treesitter";
import { DEFAULT_CHUNK_OPTIONS, type Chunk } from "./types";

vi.mock("./fallback", () => ({ chunkWindows: vi.fn() }));
vi.mock("./markdown", () => ({ chunkMarkdown: vi.fn() }));
vi.mock("./treesitter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./treesitter")>();
  return { ...actual, chunkWithTreeSitter: vi.fn(actual.chunkWithTreeSitter) };
});

const stub: Chunk = {
  startLine: 1,
  endLine: 1,
  startByte: 0,
  endByte: 1,
  kind: "window",
  symbol: null,
  parentSymbol: null,
  signature: null,
  text: "x",
};

beforeEach(() => {
  vi.mocked(chunkWindows).mockReset().mockReturnValue([stub]);
  vi.mocked(chunkMarkdown).mockReset().mockReturnValue([stub]);
});

describe("hasGrammar", () => {
  it("is true for every supported code language", () => {
    for (const l of ["typescript", "tsx", "javascript", "python", "go", "rust", "java", "csharp", "c", "cpp", "php", "ruby", "kotlin"]) {
      expect(hasGrammar(l), l).toBe(true);
    }
  });

  it("is false for markdown, unknown and null", () => {
    for (const l of ["markdown", "cobol", "toString", "", null]) expect(hasGrammar(l), String(l)).toBe(false);
  });
});

describe("initChunker", () => {
  it("is idempotent", async () => {
    const a = initChunker();
    const b = initChunker();
    expect(a).toBe(b);
    await a;
    await initChunker();
  });
});

describe("chunkFile", () => {
  it("uses tree-sitter for languages with a grammar", async () => {
    const { chunks } = await chunkFile("a.py", "python", "def f():\n    return 1\n");
    expect(chunks.map((c) => [c.kind, c.symbol])).toEqual([["function", "f"]]);
    expect(chunkWindows).not.toHaveBeenCalled();
  });

  it("routes markdown to chunkMarkdown with the options", async () => {
    const opts = { ...DEFAULT_CHUNK_OPTIONS, maxTokens: 123 };
    expect(await chunkFile("a.md", "markdown", "# T", opts)).toEqual({ chunks: [stub], refs: [] });
    expect(chunkMarkdown).toHaveBeenCalledWith("# T", opts);
  });

  it("falls back to windows for unknown or missing language", async () => {
    expect(await chunkFile("a.xyz", "cobol", "data")).toEqual({ chunks: [stub], refs: [] });
    expect(await chunkFile("a", null, "data")).toEqual({ chunks: [stub], refs: [] });
    expect(chunkWindows).toHaveBeenCalledTimes(2);
  });

  it("returns refs from tree-sitter and none for a language without queries", async () => {
    const py = await chunkFile("a.py", "python", "def f():\n    g()\n");
    expect(py.refs.map((r) => [r.name, r.kind])).toEqual([["g", "call"]]);
    const go = await chunkFile("a.go", "go", "package a\nfunc f() { g() }\n");
    expect(go.chunks.length).toBeGreaterThan(0);
    expect(go.refs).toEqual([]);
  });

  it("falls back to windows when tree-sitter fails", async () => {
    vi.mocked(chunkWithTreeSitter).mockRejectedValueOnce(new Error("boom"));
    expect(await chunkFile("a.go", "go", "package a")).toEqual({ chunks: [stub], refs: [] });
    expect(chunkWindows).toHaveBeenCalledWith("package a");
  });
});
