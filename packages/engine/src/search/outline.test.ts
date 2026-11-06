import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openIndexStore } from "../store/sqlite";
import type { ChunkInput, IndexStore } from "../store/types";
import { outline } from "./outline";

let dir: string;
let store: IndexStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-outline-"));
  store = openIndexStore(join(dir, "index.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function chunk(
  startLine: number,
  endLine: number,
  symbol: string | null,
  extra: Partial<ChunkInput> = {},
): ChunkInput {
  return {
    startLine,
    endLine,
    startByte: startLine * 100,
    endByte: endLine * 100 + 99,
    kind: "function",
    symbol,
    parentSymbol: null,
    signature: symbol ? `${symbol}()` : null,
    chunkHash: `h-${startLine}-${symbol}`,
    text: `body ${startLine}`,
    fts: { text: `body ${startLine}`, symbol: symbol ?? "", path: "a.ts" },
    ...extra,
  };
}

function index(path: string, chunks: ChunkInput[]) {
  store.upsertFile({ path, lang: "ts", size: 1, mtime: 1, contentHash: `c-${path}` }, chunks);
}

describe("outline", () => {
  it("returns symbols with ranges and signatures in line order", () => {
    index("a.ts", [chunk(7, 12, "beta"), chunk(1, 5, "alpha")]);
    const r = outline(store, { path: "a.ts" });
    expect(r.path).toBe("a.ts");
    expect(r.lang).toBe("ts");
    expect(r.symbols).toEqual([
      { symbol: "alpha", parentSymbol: null, kind: "function", signature: "alpha()", range: { startLine: 1, endLine: 5 } },
      { symbol: "beta", parentSymbol: null, kind: "function", signature: "beta()", range: { startLine: 7, endLine: 12 } },
    ]);
  });

  it("merges chunks of one symbol into a single entry with the union range", () => {
    index("a.ts", [
      chunk(1, 20, "big", { signature: "big(a)", kind: "function" }),
      chunk(21, 40, "big", { signature: "other", kind: "block" }),
      chunk(41, 45, "small"),
    ]);
    const r = outline(store, { path: "a.ts" });
    expect(r.symbols).toHaveLength(2);
    expect(r.symbols[0]).toMatchObject({ symbol: "big", kind: "function", signature: "big(a)", range: { startLine: 1, endLine: 40 } });
    expect(r.symbols[1]?.symbol).toBe("small");
  });

  it("keeps methods of a large class as separate entries", () => {
    index("a.ts", [
      chunk(1, 10, "Big", { kind: "class" }),
      chunk(11, 20, "run", { kind: "method", parentSymbol: "Big" }),
      chunk(21, 30, "stop", { kind: "method", parentSymbol: "Big" }),
      chunk(31, 40, "run", { kind: "method", parentSymbol: "Big" }),
    ]);
    const r = outline(store, { path: "a.ts" });
    expect(r.symbols.map((s) => [s.symbol, s.parentSymbol, s.range.startLine, s.range.endLine])).toEqual([
      ["Big", null, 1, 10],
      ["run", "Big", 11, 40],
      ["stop", "Big", 21, 30],
    ]);
  });

  it("never merges chunks without a symbol", () => {
    index("a.ts", [chunk(1, 3, null, { kind: "block" }), chunk(4, 6, null, { kind: "block" })]);
    const r = outline(store, { path: "a.ts" });
    expect(r.symbols).toHaveLength(2);
    expect(r.symbols[0]).toMatchObject({ symbol: null, signature: null, range: { startLine: 1, endLine: 3 } });
  });

  it("returns no symbols for an unindexed path", () => {
    const r = outline(store, { path: "missing.ts" });
    expect(r.symbols).toEqual([]);
    expect(r.lang).toBeNull();
  });
});
