import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../config/types";
import { ProviderUnavailableError } from "../errors";
import { getModel } from "./catalog";
import type { Embedder } from "./types";
import { createInferencePool, createWorkerEmbedder, tsxExecArgv, type InferencePool } from "./worker";

const FIXTURE = fileURLToPath(new URL("./worker.fixture.ts", import.meta.url));
const OPTS = { modelsDir: "/nonexistent", threads: 1 };

function expected(text: string): number[] {
  const v = new Float32Array(8);
  for (let i = 0; i < text.length; i++) v[i % 8]! += text.charCodeAt(i) % 31;
  v[0]! += 1;
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return Array.from(v);
}

const made: Embedder[] = [];
const pools: InferencePool[] = [];
const tmp: string[] = [];

function make(env: Record<string, string> = {}, idleUnloadMs?: number): Embedder {
  const e = createWorkerEmbedder(getModel(DEFAULTS.model), OPTS, {
    modulePath: FIXTURE,
    execArgv: tsxExecArgv(),
    env: { ...process.env, ...env },
    idleUnloadMs,
  });
  made.push(e);
  return e;
}

function spawnLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-worker-"));
  tmp.push(dir);
  return join(dir, "spawns.log");
}

function spawns(file: string): number[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((e) => e.dispose()));
  await Promise.all(pools.splice(0).map((p) => p.dispose()));
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createWorkerEmbedder", () => {
  it("returns vectors in input order across mixed-length documents", async () => {
    const e = make();
    const texts = Array.from({ length: 40 }, (_, i) => "x".repeat(((i * 37) % 200) + 1) + i);
    texts.push("y".repeat(5000));
    const out = await e.embedDocuments(texts);
    expect(out).toHaveLength(texts.length);
    out.forEach((v, i) => expect(Array.from(v)).toEqual(expected(texts[i]!)));
  });

  it("keeps the parent event loop responsive while the child is busy", async () => {
    const e = make({ FIXTURE_BUSY_MS: "200" });
    await e.init();
    let maxLag = 0;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const texts = Array.from({ length: 32 }, (_, i) => `doc ${i}`);
    await Promise.all([e.embedDocuments(texts.slice(0, 16)), e.embedDocuments(texts.slice(16))]);
    clearInterval(t);
    expect(maxLag).toBeLessThan(50);
  });

  it("serves queries and interactive documents ahead of batch documents", async () => {
    const e = make({ FIXTURE_BUSY_MS: "150" });
    await e.init();
    const order: string[] = [];
    const batch = e.embedDocuments(Array.from({ length: 40 }, (_, i) => `batch ${i}`)).then(() => order.push("batch"));
    await sleep(50);
    const query = e.embedQueries(["q"]).then(() => order.push("query"));
    const one = e.embedDocuments(["similar"]).then(() => order.push("one"));
    await Promise.all([batch, query, one]);
    expect(order).toEqual(["query", "one", "batch"]);
  });

  it("waits for at most one in-flight request when a query arrives", async () => {
    const e = make({ FIXTURE_BUSY_MS: "200" });
    await e.init();
    const batch = e.embedDocuments(Array.from({ length: 40 }, (_, i) => `batch ${i}`));
    await sleep(50);
    const t0 = performance.now();
    await e.embedQueries(["q"]);
    expect(performance.now() - t0).toBeLessThan(450);
    await batch;
  });

  it("rejects fast on abort, drops queued work and keeps working", async () => {
    const e = make({ FIXTURE_BUSY_MS: "200" });
    await e.init();
    const ac = new AbortController();
    const p = e.embedDocuments(Array.from({ length: 40 }, (_, i) => `batch ${i}`), ac.signal);
    const assertion = expect(p).rejects.toThrow("stop");
    await sleep(50);
    const t0 = performance.now();
    ac.abort(new Error("stop"));
    await assertion;
    expect(performance.now() - t0).toBeLessThan(100);
    const [v] = await e.embedQueries(["after"]);
    expect(Array.from(v!)).toEqual(expected("after"));
  });

  it("maps a native crash to ProviderUnavailableError and restarts on the next call", async () => {
    const log = spawnLog();
    const e = make({ FIXTURE_SPAWN_LOG: log });
    await e.init();
    const err = await e.embedQueries(["__crash__"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toMatch(/SIGTRAP|code/);
    const [v] = await e.embedQueries(["ok"]);
    expect(Array.from(v!)).toEqual(expected("ok"));
    expect(spawns(log)).toHaveLength(2);
  });

  it("stops restarting after three consecutive crashes", async () => {
    const log = spawnLog();
    const e = make({ FIXTURE_SPAWN_LOG: log });
    for (let i = 0; i < 3; i++) {
      await expect(e.embedQueries(["__crash__"])).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
    expect(spawns(log)).toHaveLength(3);
    const err = await e.embedQueries(["ok"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as ProviderUnavailableError).retryAfterMs).toBe(600_000);
    expect(spawns(log)).toHaveLength(3);
  });

  it("preserves init error types", async () => {
    await expect(make({ FIXTURE_INIT_FAIL: "provider" }).init()).rejects.toMatchObject({
      name: "ProviderUnavailableError",
      retryAfterMs: 1234,
    });
    const err = await make({ FIXTURE_INIT_FAIL: "error" })
      .init()
      .catch((x: unknown) => x);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toBe("fixture init failed");
  });

  it("terminates the child on dispose and never spawns another", async () => {
    const log = spawnLog();
    const e = make({ FIXTURE_SPAWN_LOG: log });
    await e.init();
    const [pid] = spawns(log);
    await e.dispose();
    expect(() => process.kill(pid!, 0)).toThrow();
    await expect(e.embedQueries(["again"])).rejects.toThrow("embedder disposed");
    await expect(e.embedDocuments(["again"])).rejects.toThrow("embedder disposed");
    await expect(e.init()).rejects.toThrow("embedder disposed");
    expect(spawns(log)).toHaveLength(1);
  });

  it("unloads the model after an idle period and loads it again on demand", async () => {
    const log = spawnLog();
    const e = make({ FIXTURE_SPAWN_LOG: log }, 100);
    await e.embedQueries(["first"]);
    const [pid] = spawns(log);
    await sleep(400);
    expect(() => process.kill(pid!, 0)).toThrow();
    const [v] = await e.embedQueries(["second"]);
    expect(Array.from(v!)).toEqual(expected("second"));
    expect(spawns(log)).toHaveLength(2);
  });

  it("unload finishes in-flight work first", async () => {
    const log = spawnLog();
    const e = make({ FIXTURE_SPAWN_LOG: log, FIXTURE_BUSY_MS: "150" });
    await e.init();
    const [pid] = spawns(log);
    const docs = e.embedDocuments(["a", "b"]);
    await e.unload!();
    expect((await docs).map((v) => Array.from(v))).toEqual([expected("a"), expected("b")]);
    await sleep(300);
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it.skipIf(process.platform === "win32")("lowers the child priority", async () => {
    const e = make();
    const [v] = await e.embedQueries(["__priority__"]);
    expect(v![0]).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it("estimates tokens locally", () => {
    expect(make().countTokens("abcdefghi")).toBe(3);
  });
});

describe("createInferencePool", () => {
  const A = getModel("qwen3-embedding-0.6b");
  const B = getModel("potion-code-16m");

  function makePool(env: Record<string, string> = {}, idleUnloadMs?: number): InferencePool {
    const p = createInferencePool({
      modulePath: FIXTURE,
      execArgv: tsxExecArgv(),
      env: { ...process.env, ...env },
      idleUnloadMs,
      threads: 1,
    });
    pools.push(p);
    return p;
  }

  function lines(file: string): string[] {
    try {
      return readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  it("serves two models from one child", async () => {
    const spawnFile = spawnLog();
    const loadFile = spawnLog();
    const pool = makePool({ FIXTURE_SPAWN_LOG: spawnFile, FIXTURE_LOAD_LOG: loadFile });
    const a = pool.embedder(A, OPTS);
    const b = pool.embedder(B, OPTS);
    const [va, vb] = await Promise.all([a.embedQueries(["one"]), b.embedQueries(["two"])]);
    expect(Array.from(va[0]!)).toEqual(expected("one"));
    expect(Array.from(vb[0]!)).toEqual(expected("two"));
    expect(spawns(spawnFile)).toHaveLength(1);
    expect(lines(loadFile).sort()).toEqual([`load ${A.id}`, `load ${B.id}`].sort());
  });

  it("lets a query of one model overtake a batch of another at a sub-request boundary", async () => {
    const pool = makePool({ FIXTURE_BUSY_MS: "150" });
    const a = pool.embedder(A, OPTS);
    const b = pool.embedder(B, OPTS);
    await Promise.all([a.init(), b.init()]);
    const order: string[] = [];
    const batch = b.embedDocuments(Array.from({ length: 40 }, (_, i) => `batch ${i}`)).then(() => order.push("batch"));
    await sleep(50);
    const query = a.embedQueries(["q"]).then(() => order.push("query"));
    await Promise.all([batch, query]);
    expect(order).toEqual(["query", "batch"]);
  });

  it("never has two requests in flight, loads included", async () => {
    const overlap = spawnLog();
    const pool = makePool({ FIXTURE_INFLIGHT_LOG: overlap, FIXTURE_LOAD_MS: "50", FIXTURE_BUSY_MS: "20" });
    const a = pool.embedder(A, OPTS);
    const b = pool.embedder(B, OPTS);
    const docs = Array.from({ length: 30 }, (_, i) => `doc ${i}`);
    await Promise.all([
      a.embedDocuments(docs),
      b.embedDocuments(docs),
      a.embedQueries(["q1"]),
      b.embedQueries(["q2"]),
      b.init(),
    ]);
    expect(lines(overlap)).toEqual([]);
  });

  it("unloads each model separately and stops the child after the last one", async () => {
    const spawnFile = spawnLog();
    const loadFile = spawnLog();
    const pool = makePool({ FIXTURE_SPAWN_LOG: spawnFile, FIXTURE_LOAD_LOG: loadFile }, 150);
    const a = pool.embedder(A, OPTS);
    const b = pool.embedder(B, OPTS);
    await Promise.all([a.init(), b.init()]);
    const [pid] = spawns(spawnFile);
    for (let i = 0; i < 6; i++) {
      await b.embedQueries(["keep"]);
      await sleep(50);
    }
    expect(lines(loadFile)).toContain(`unload ${A.id}`);
    expect(lines(loadFile)).not.toContain(`unload ${B.id}`);
    expect(() => process.kill(pid!, 0)).not.toThrow();
    const [v] = await b.embedQueries(["still"]);
    expect(Array.from(v!)).toEqual(expected("still"));
    await sleep(500);
    expect(lines(loadFile)).toContain(`unload ${B.id}`);
    expect(() => process.kill(pid!, 0)).toThrow();
    await a.embedQueries(["again"]);
    expect(spawns(spawnFile)).toHaveLength(2);
  });

  it("remembers the thread count for the next spawn without restarting", async () => {
    const spawnFile = spawnLog();
    const pool = makePool({ FIXTURE_SPAWN_LOG: spawnFile });
    await pool.embedder(A, OPTS).init();
    await pool.setThreads(3);
    expect(pool.threads).toBe(3);
    expect(spawns(spawnFile)).toHaveLength(1);
  });
});
