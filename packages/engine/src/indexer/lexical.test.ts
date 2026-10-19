import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSettings } from "../config/types";
import { DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import { openIndexStore } from "../store/sqlite";
import type { IndexStore } from "../store/types";
import { initHashing } from "../util/hash";
import * as scanRead from "../scan/read";
import { applyChanges, runLexical } from "./lexical";
import type { IndexerContext } from "./types";

const testSettings: EffectiveSettings = {
  indexLocation: "project",
  maxFileKb: 512,
  threads: 1,
  threadsExplicit: false,
  pauseOnBattery: false,
  exclude: [],
  searchMode: "hybrid",
  searchTop: 20,
  provider: "local",
  model: "m",
  providers: {},
  allowRemote: false,
};

let root: string;
let dbDir: string;
let store: IndexStore;

function ctx(): IndexerContext {
  return {
    root,
    indexDir: join(root, ".code-embed"),
    store,
    settings: testSettings,
    chunkOptions: DEFAULT_CHUNK_OPTIONS,
    onProgress: () => {},
    onError: (e) => {
      throw new Error(e.message);
    },
  };
}

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  await initHashing();
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ce-lex-")));
  dbDir = realpathSync(mkdtempSync(join(tmpdir(), "ce-lexdb-")));
  store = openIndexStore(join(dbDir, "index.db"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

describe("runLexical", () => {
  it("indexes an empty index with embedded = 0 and fts", async () => {
    write("src/a.ts", "export function computeTotalPrice(items: number[]) {\n  return items.length;\n}\n");
    write("README.md", "# Title\n\nhello world\n");
    const r = await runLexical(ctx());
    expect(r.scanned).toBe(2);
    expect(r.changed).toBe(2);
    const c = store.counts();
    expect(c.files).toBe(2);
    expect(c.chunks).toBeGreaterThan(0);
    expect(c.embedded).toBe(0);
    expect(store.searchFts("computeTotalPrice", 5).length).toBeGreaterThan(0);
    expect(store.searchFts("total", 5).length).toBeGreaterThan(0);
  });

  it("skips unchanged, reindexes changed, removes deleted", async () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "export const b = 1;\n");
    await runLexical(ctx());
    const again = await runLexical(ctx());
    expect(again).toMatchObject({ changed: 0, skipped: 2, deleted: 0 });

    write("a.ts", "export const a = 22;\n");
    rmSync(join(root, "b.ts"));
    const third = await runLexical(ctx());
    expect(third).toMatchObject({ changed: 1, deleted: 1 });
    expect(store.getFile("b.ts")).toBeUndefined();
    expect(store.chunksForFile("a.ts")[0]?.text).toContain("22");
  });

  it("skips by hash when only mtime changed", async () => {
    write("a.ts", "export const a = 1;\n");
    await runLexical(ctx());
    const t = new Date(Date.now() + 60_000);
    utimesSync(join(root, "a.ts"), t, t);
    const r = await runLexical(ctx());
    expect(r).toMatchObject({ changed: 0, skipped: 1 });
  });

  it("touches mtime on hash match so the next pass does not read the file", async () => {
    write("a.ts", "export const a = 1;\n");
    await runLexical(ctx());
    const t = new Date(Date.now() + 60_000);
    utimesSync(join(root, "a.ts"), t, t);
    const mtime = statSync(join(root, "a.ts")).mtimeMs;
    const touchSpy = vi.spyOn(store, "touchFile");
    const readSpy = vi.spyOn(scanRead, "readCandidate");
    await runLexical(ctx());
    expect(touchSpy).toHaveBeenCalledWith("a.ts", mtime, 20);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(store.getFile("a.ts")?.mtime).toBe(mtime);
    readSpy.mockClear();
    const r = await runLexical(ctx());
    expect(readSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ changed: 0, skipped: 1 });
    readSpy.mockRestore();
  });

  it("applyChanges touches mtime on hash match", async () => {
    write("a.ts", "export const a = 1;\n");
    await runLexical(ctx());
    const t = new Date(Date.now() + 120_000);
    utimesSync(join(root, "a.ts"), t, t);
    const out = await applyChanges(ctx(), { created: [], changed: [join(root, "a.ts")], deleted: [] });
    expect(out.changedPaths).toEqual([]);
    expect(store.getFile("a.ts")?.mtime).toBe(statSync(join(root, "a.ts")).mtimeMs);
  });

  it("stores the signature on every piece of a split function", async () => {
    const body = Array.from({ length: 60 }, (_, i) => `  total += compute(${i}) * factor${i};`).join("\n");
    write("a.ts", `export function bigFunction(factor: number): number {\n  let total = 0;\n${body}\n  return total;\n}\n`);
    const c = { ...ctx(), chunkOptions: { ...DEFAULT_CHUNK_OPTIONS, maxTokens: 60 } };
    await runLexical(c);
    const chunks = store.chunksForFile("a.ts");
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(ch.signature).toContain("bigFunction");
  });

  it("stops by budget", async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.ts`, `export const v${i} = ${i};\n`);
    const r = await runLexical(ctx(), { budgetMs: -1 });
    expect(r.timedOut).toBe(true);
    expect(r.changed).toBe(0);
    expect(r.deleted).toBe(0);
  });

  it("abort mid-pass leaves a consistent index; rerun completes", async () => {
    for (let i = 0; i < 120; i++) write(`f${i}.ts`, `export const v${i} = ${i};\n`);
    const ac = new AbortController();
    const c = ctx();
    let n = 0;
    c.onProgress = () => {
      if (++n === 3) ac.abort();
    };
    const partial = await runLexical(c, { signal: ac.signal });
    expect(partial.changed).toBeLessThan(120);
    store.close();
    store = openIndexStore(join(dbDir, "index.db"));
    expect(store.counts().files).toBe(partial.changed);
    const rest = await runLexical(ctx());
    expect(store.counts().files).toBe(120);
    expect(rest.changed + partial.changed).toBe(120);
  });

  it("indexes 20k generated lines in reasonable time", async () => {
    for (let f = 0; f < 100; f++) {
      let s = "";
      for (let i = 0; i < 50; i++) s += `export function fn${f}_${i}(a: number) {\n  const x = a + ${i};\n  return x * ${f};\n}\n\n`;
      write(`gen/m${f}.ts`, s);
    }
    const t = Date.now();
    await runLexical(ctx());
    expect(store.counts().files).toBe(100);
    expect(Date.now() - t).toBeLessThan(60_000);
  }, 90_000);
});

describe("applyChanges", () => {
  it("handles created/changed/deleted in one batch", async () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "export const b = 1;\n");
    await runLexical(ctx());
    write("a.ts", "export const a = 333;\n");
    write("c.ts", "export const c = 1;\n");
    rmSync(join(root, "b.ts"));
    const r = await applyChanges(ctx(), {
      created: [join(root, "c.ts")],
      changed: [join(root, "a.ts")],
      deleted: [join(root, "b.ts")],
    });
    expect(r.changedPaths.sort()).toEqual(["a.ts", "c.ts"]);
    expect(store.getFile("b.ts")).toBeUndefined();
    expect(store.getFile("c.ts")).toBeDefined();
    expect(store.chunksForFile("a.ts")[0]?.text).toContain("333");
  });
});
