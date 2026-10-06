import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openIndexStore } from "../store/sqlite";
import type { IndexStore } from "../store/types";
import { lexicalCandidates } from "./lexical";

let dir: string;
let store: IndexStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-lex-"));
  store = openIndexStore(join(dir, "index.db"));
  for (let i = 0; i < 30; i++) {
    const path = `${i % 2 ? "odd" : "even"}/f${i}.ts`;
    const text = `shared token ${i}`;
    store.upsertFile(
      { path, lang: "typescript", size: 1, mtime: 1, contentHash: `c${i}` },
      [{ startLine: 1, endLine: 1, startByte: 0, endByte: 5, kind: "function", symbol: null, parentSymbol: null, chunkHash: `h${i}`, text, fts: { text, symbol: "", path } }],
    );
  }
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("lexicalCandidates", () => {
  it("returns nothing for empty query", () => {
    expect(lexicalCandidates(store, "(( ))", 10, {})).toEqual([]);
  });
  it("over-fetches when a post-filter drops candidates", () => {
    const out = lexicalCandidates(store, "shared", 10, {}, (p) => p.startsWith("odd/"));
    expect(out).toHaveLength(10);
    const paths = store.getChunks(out.map((o) => o.id)).map((c) => c.path);
    expect(paths.every((p) => p.startsWith("odd/"))).toBe(true);
  });
  it("throws on aborted signal", () => {
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    expect(() => lexicalCandidates(store, "shared", 5, {}, undefined, ac.signal)).toThrow("stop");
  });
});
