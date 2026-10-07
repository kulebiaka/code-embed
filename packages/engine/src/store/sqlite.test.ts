import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexCorruptError } from "../errors";
import { openDatabase } from "./driver";
import { openIndexStore } from "./sqlite";
import type { ChunkInput, IndexStore } from "./types";

let dir: string;
let dbPath: string;
let store: IndexStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-store-"));
  dbPath = join(dir, "index.db");
  store = openIndexStore(dbPath);
});
afterEach(() => {
  try {
    store.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function chunk(text: string, symbol: string, path: string, n = 0): ChunkInput {
  return {
    startLine: n * 10 + 1,
    endLine: n * 10 + 9,
    startByte: n * 100,
    endByte: n * 100 + 99,
    kind: "function",
    symbol: symbol || null,
    parentSymbol: null,
    chunkHash: `h-${text}`,
    text,
    fts: { text, symbol, path },
  };
}

function file(path: string, lang: string | null = "ts") {
  return { path, lang, size: 10, mtime: 1, contentHash: `c-${path}` };
}

const vec = (...v: number[]) => Int8Array.from(v);

describe("schema and files", () => {
  it("upserts, replaces chunks and deletes", () => {
    const a = store.upsertFile(file("a.ts"), [chunk("alpha beta", "", "a.ts", 0), chunk("gamma", "", "a.ts", 1)]);
    expect(a.chunkIds).toHaveLength(2);
    expect(store.counts()).toEqual({ files: 1, chunks: 2, embedded: 0 });
    expect(store.getFile("a.ts")?.contentHash).toBe("c-a.ts");
    const b = store.upsertFile(file("a.ts"), [chunk("delta", "", "a.ts")]);
    expect(b.fileId).toBe(a.fileId);
    expect(store.counts().chunks).toBe(1);
    expect(store.searchFts("alpha", 10)).toEqual([]);
    expect(store.searchFts("delta", 10)).toHaveLength(1);
    expect(store.chunksForFile("a.ts")[0]).toMatchObject({ text: "delta", path: "a.ts", embedded: false });
    store.deleteFile("a.ts");
    expect(store.counts()).toEqual({ files: 0, chunks: 0, embedded: 0 });
    expect(store.searchFts("delta", 10)).toEqual([]);
    expect(store.listFiles()).toEqual([]);
  });

  it("meta roundtrip", () => {
    expect(store.getMeta("k")).toBeUndefined();
    store.setMeta("k", "v1");
    store.setMeta("k", "v2");
    expect(store.getMeta("k")).toBe("v2");
  });
});

describe("fts", () => {
  it("weights symbol and path, filters by lang and prefix", () => {
    store.upsertFile(file("src/x.ts"), [chunk("handler stuff", "", "src/x.ts")]);
    store.upsertFile(file("src/y.ts"), [chunk("other", "handler", "src/y.ts")]);
    store.upsertFile(file("lib/handler.py", "py"), [chunk("other", "", "lib/handler.py")]);
    const hits = store.searchFts("handler", 10);
    expect(hits).toHaveLength(3);
    const byPath = (id: number) => store.getChunks([id])[0]!.path;
    expect(byPath(hits[0]!.chunkId)).toBe("src/y.ts");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[1]!.score).toBeGreaterThan(0);
    expect(store.searchFts("handler", 10, { lang: "py" })).toHaveLength(1);
    expect(store.searchFts("handler", 10, { pathPrefix: "src/" })).toHaveLength(2);
  });
});

describe("vectors", () => {
  it("setVectorDims, setEmbeddings, searchVec, pendingChunks", () => {
    const r = store.upsertFile(file("a.ts"), [chunk("a", "", "a.ts", 0), chunk("b", "", "a.ts", 1), chunk("c", "", "a.ts", 2)]);
    expect(store.dims).toBeNull();
    store.setVectorDims(4);
    expect(store.dims).toBe(4);
    expect(store.pendingChunks(10)).toHaveLength(3);
    expect(store.pendingChunks(2)).toHaveLength(2);
    expect(store.pendingChunks(10, ["zzz"])).toHaveLength(0);
    const [i1, i2, i3] = r.chunkIds as [number, number, number];
    store.setEmbeddings([
      { chunkId: i1, vector: vec(127, 0, 0, 0) },
      { chunkId: i2, vector: vec(0, 127, 0, 0) },
      { chunkId: i3, vector: vec(100, 20, 0, 0) },
    ]);
    expect(store.counts().embedded).toBe(3);
    expect(store.pendingChunks(10)).toHaveLength(0);
    expect(store.searchVec(vec(127, 1, 0, 0), 2).map((h) => h.chunkId)).toEqual([i1, i3]);
    expect(Array.from(store.getVectors([i2]).get(i2)!)).toEqual([0, 127, 0, 0]);
    store.setVectorDims(2);
    expect(store.counts().embedded).toBe(0);
    expect(store.pendingChunks(10)).toHaveLength(3);
    expect(store.searchVec(vec(1, 0), 2)).toEqual([]);
    expect(store.chunksForFile("a.ts")).toHaveLength(3);
  });

  it("filters kNN and removes vectors with replaced chunks", () => {
    const a = store.upsertFile(file("src/a.ts"), [chunk("a", "", "src/a.ts")]);
    const b = store.upsertFile(file("lib/b.py", "py"), [chunk("b", "", "lib/b.py")]);
    store.setVectorDims(2);
    store.setEmbeddings([
      { chunkId: a.chunkIds[0]!, vector: vec(127, 0) },
      { chunkId: b.chunkIds[0]!, vector: vec(100, 10) },
    ]);
    expect(store.searchVec(vec(127, 0), 5, { lang: "py" }).map((h) => h.chunkId)).toEqual([b.chunkIds[0]]);
    expect(store.searchVec(vec(127, 0), 5, { pathPrefix: "src/" }).map((h) => h.chunkId)).toEqual([a.chunkIds[0]]);
    store.upsertFile(file("src/a.ts"), []);
    expect(store.searchVec(vec(127, 0), 5)).toHaveLength(1);
    store.deleteFile("lib/b.py");
    expect(store.searchVec(vec(127, 0), 5)).toEqual([]);
  });
});

describe("transactions", () => {
  it("rolls back a failed batch", () => {
    store.upsertFile(file("keep.ts"), [chunk("keep", "", "keep.ts")]);
    expect(() =>
      store.transaction(() => {
        store.upsertFile(file("a.ts"), [chunk("one", "", "a.ts")]);
        store.upsertFile(file("keep.ts"), [chunk("replaced", "", "keep.ts")]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.counts()).toEqual({ files: 1, chunks: 1, embedded: 0 });
    expect(store.searchFts("keep", 5)).toHaveLength(1);
    expect(store.searchFts("one", 5)).toHaveLength(0);
    expect(store.searchFts("replaced", 5)).toHaveLength(0);
  });

  it("nested failure rolls back only the inner part", () => {
    store.transaction(() => {
      store.upsertFile(file("a.ts"), [chunk("one", "", "a.ts")]);
      expect(() =>
        store.transaction(() => {
          store.upsertFile(file("b.ts"), [chunk("two", "", "b.ts")]);
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(store.listFiles().map((f) => f.path)).toEqual(["a.ts"]);
  });
});

describe("corruption and readonly", () => {
  it("throws IndexCorruptError on garbage", () => {
    store.close();
    writeFileSync(dbPath, Buffer.alloc(8192, 0x41));
    expect(() => openIndexStore(dbPath)).toThrow(IndexCorruptError);
    store = openIndexStore(join(dir, "other.db"));
  });

  it("readonly rejects writes and reads alongside a writer", () => {
    store.upsertFile(file("a.ts"), [chunk("hello", "", "a.ts")]);
    store.setVectorDims(2);
    const ro = openIndexStore(dbPath, { readonly: true });
    expect(ro.readonly).toBe(true);
    expect(ro.dims).toBe(2);
    expect(() => ro.upsertFile(file("b.ts"), [])).toThrow();
    expect(ro.searchFts("hello", 5)).toHaveLength(1);
    store.upsertFile(file("b.ts"), [chunk("world", "", "b.ts")]);
    expect(ro.searchFts("world", 5)).toHaveLength(1);
    expect(ro.counts().files).toBe(2);
    ro.close();
  });
});

describe("signature and touchFile", () => {
  it("round-trips signature and defaults to null", () => {
    const withSig = { ...chunk("alpha", "", "a.ts", 0), signature: "function alpha(x: number)" };
    const { chunkIds } = store.upsertFile(file("a.ts"), [withSig, chunk("beta", "", "a.ts", 1)]);
    expect(store.chunksForFile("a.ts").map((c) => c.signature)).toEqual(["function alpha(x: number)", null]);
    expect(store.getChunks(chunkIds).map((c) => c.signature)).toEqual(["function alpha(x: number)", null]);
    expect(store.pendingChunks(10).map((c) => c.signature)).toEqual(["function alpha(x: number)", null]);
  });

  it("touchFile updates only mtime, size and indexed_at", () => {
    store.setVectorDims(2);
    const { chunkIds } = store.upsertFile(file("a.ts"), [chunk("alpha", "", "a.ts")]);
    store.setEmbeddings([{ chunkId: chunkIds[0]!, vector: vec(1, 2) }]);
    const before = store.getFile("a.ts")!;
    const chunksBefore = store.chunksForFile("a.ts");
    store.touchFile("a.ts", 99, 1234);
    const after = store.getFile("a.ts")!;
    expect(after).toMatchObject({ mtime: 99, size: 1234, contentHash: before.contentHash, lang: before.lang, id: before.id });
    expect(after.indexedAt).toBeGreaterThanOrEqual(before.indexedAt);
    expect(store.chunksForFile("a.ts")).toEqual(chunksBefore);
    expect(store.searchFts("alpha", 5)).toHaveLength(1);
    expect(store.getVectors(chunkIds).get(chunkIds[0]!)).toEqual(vec(1, 2));
    expect(store.counts().embedded).toBe(1);
    expect(() => store.touchFile("missing.ts", 1, 1)).not.toThrow();
    expect(store.getFile("missing.ts")).toBeUndefined();
  });

  it("reads an old-schema index read-only with signature null", () => {
    const old = join(dir, "old.db");
    const db = openDatabase(old, false);
    db.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, lang TEXT, size INTEGER NOT NULL, mtime REAL NOT NULL, content_hash TEXT NOT NULL, indexed_at INTEGER NOT NULL);
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        kind TEXT NOT NULL,
        symbol TEXT,
        parent_symbol TEXT,
        chunk_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        embedded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO files VALUES (1, 'a.ts', 'ts', 10, 1, 'c', 1);
      INSERT INTO chunks(id, file_id, start_line, end_line, start_byte, end_byte, kind, symbol, parent_symbol, chunk_hash, text)
        VALUES (1, 1, 1, 2, 0, 9, 'function', 'a', NULL, 'h', 'old text');
    `);
    db.close();
    const ro = openIndexStore(old, { readonly: true });
    expect(ro.getChunks([1])[0]).toMatchObject({ text: "old text", signature: null });
    expect(ro.chunksForFile("a.ts")[0]!.signature).toBeNull();
    expect(ro.pendingChunks(5)[0]!.signature).toBeNull();
    ro.close();
  });
});
