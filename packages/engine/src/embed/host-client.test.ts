import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../config/types";
import { isProcessAlive } from "../core/lock";
import { ProviderUnavailableError } from "../errors";
import { getModel } from "./catalog";
import { createHostEmbedder, type HostEmbedderOptions } from "./host-client";
import type { Embedder } from "./types";
import { tsxExecArgv } from "./worker";

const FIXTURE = fileURLToPath(new URL("./worker.fixture.ts", import.meta.url));

function fakeVector(text: string): Float32Array {
  const v = new Float32Array(8);
  for (let i = 0; i < text.length; i++) v[i % 8]! += text.charCodeAt(i) % 31;
  v[0]! += 1;
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

let dir: string;
let cache: string;
let spawnLog: string;
const made: Embedder[] = [];

function make(env: Record<string, string> = {}, o: HostEmbedderOptions = {}): Embedder {
  const e = createHostEmbedder(
    getModel(DEFAULTS.model),
    { modelsDir: join(dir, "models"), threads: 1 },
    {
      env: { ...process.env, CODE_EMBED_CACHE_DIR: cache, FIXTURE_SPAWN_LOG: spawnLog, ...env },
      worker: { modulePath: FIXTURE, execArgv: tsxExecArgv() },
      ...o,
    },
  );
  made.push(e);
  return e;
}

function hostPids(): number[] {
  return readdirSync(cache)
    .filter((n) => n.startsWith("embed-host-") && n.endsWith(".lock"))
    .map((n) => Number(readFileSync(join(cache, n), "utf8")));
}

function spawns(): number[] {
  try {
    return readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isProcessAlive(pid)) return true;
    await sleep(25);
  }
  return !isProcessAlive(pid);
}

const vec = (v: Float32Array | undefined) => Array.from(v!);
const docs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

let savedCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-host-"));
  cache = join(dir, "cache");
  spawnLog = join(dir, "spawns.log");
  savedCache = process.env.CODE_EMBED_CACHE_DIR;
  process.env.CODE_EMBED_CACHE_DIR = cache;
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((e) => e.dispose()));
  let pids: number[] = [];
  try {
    pids = hostPids();
  } catch {}
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    await waitDead(pid);
  }
  for (const pid of spawns()) await waitDead(pid);
  if (savedCache === undefined) delete process.env.CODE_EMBED_CACHE_DIR;
  else process.env.CODE_EMBED_CACHE_DIR = savedCache;
  rmSync(dir, { recursive: true, force: true });
});

describe("createHostEmbedder", () => {
  it("serves several clients from one inference process", async () => {
    const a = make();
    const b = make();
    const texts = docs("doc", 20);
    const [va, vb, [q]] = await Promise.all([a.embedDocuments(texts), b.embedDocuments(texts), b.embedQueries(["q"])]);
    va.forEach((v, i) => expect(vec(v)).toEqual(vec(fakeVector(texts[i]!))));
    expect(vb.map(vec)).toEqual(va.map(vec));
    expect(vec(q)).toEqual(vec(fakeVector("q")));
    expect(spawns()).toHaveLength(1);
    expect(hostPids()).toHaveLength(1);
    expect(a.shared).toBe(true);
  });

  it("starts a single host when clients race", async () => {
    const clients = Array.from({ length: 4 }, () => make());
    await Promise.all(clients.map((c) => c.embedQueries(["race"])));
    expect(hostPids()).toHaveLength(1);
    expect(spawns()).toHaveLength(1);
  });

  it("lets a query from another project overtake a batch", async () => {
    const a = make({ FIXTURE_BUSY_MS: "100" });
    const b = make({ FIXTURE_BUSY_MS: "100" });
    await Promise.all([a.init(), b.embedQueries(["warm"])]);
    const order: string[] = [];
    const batch = a.embedDocuments(docs("batch", 40)).then(() => order.push("batch"));
    await sleep(150);
    const t0 = performance.now();
    await b.embedQueries(["q"]).then(() => order.push("query"));
    expect(performance.now() - t0).toBeLessThan(400);
    await batch;
    expect(order).toEqual(["query", "batch"]);
  });

  it("interleaves batches of two projects", async () => {
    const a = make({ FIXTURE_BUSY_MS: "30" });
    const b = make({ FIXTURE_BUSY_MS: "30" });
    await Promise.all([a.init(), b.init()]);
    const order: string[] = [];
    const run = (e: Embedder, name: string) => e.embedDocuments(docs(name, 16)).then(() => order.push(name));
    const all = [run(a, "a1"), run(a, "a2"), run(a, "a3")];
    await sleep(20);
    all.push(run(b, "b1"));
    await Promise.all(all);
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a3"));
  });

  it("serves the active project's batches first", async () => {
    const bg = make({ FIXTURE_BUSY_MS: "30" });
    const fg = make({ FIXTURE_BUSY_MS: "30" });
    bg.setActive!(false);
    await Promise.all([bg.init(), fg.init()]);
    const order: string[] = [];
    const run = (e: Embedder, name: string) => e.embedDocuments(docs(name, 16)).then(() => order.push(name));
    const all = [run(bg, "bg1"), run(bg, "bg2")];
    await sleep(20);
    all.push(run(fg, "fg1"), run(fg, "fg2"));
    await Promise.all(all);
    expect(order.at(-1)).toBe("bg2");
  });

  it("cancels a request in the host queue", async () => {
    const a = make({ FIXTURE_BUSY_MS: "100" });
    const b = make({ FIXTURE_BUSY_MS: "100" });
    await Promise.all([a.init(), b.init()]);
    const running = a.embedDocuments(docs("a", 40));
    await sleep(20);
    const ac = new AbortController();
    const queued = b.embedDocuments(docs("b", 40), ac.signal);
    const assertion = expect(queued).rejects.toThrow("stop");
    const t0 = performance.now();
    ac.abort(new Error("stop"));
    await assertion;
    expect(performance.now() - t0).toBeLessThan(100);
    await running;
    const [v] = await b.embedQueries(["after"]);
    expect(vec(v)).toEqual(vec(fakeVector("after")));
  });

  it("passes provider errors through with their type", async () => {
    const a = make({ FIXTURE_INIT_FAIL: "provider" });
    await expect(a.embedQueries(["x"])).rejects.toMatchObject({ name: "ProviderUnavailableError", retryAfterMs: 1234 });
  });

  it("reports a host crash and starts a new host on the next call", async () => {
    const a = make({ FIXTURE_BUSY_MS: "300" });
    await a.embedQueries(["warm"]);
    const [pid] = hostPids();
    const pending = a.embedDocuments(docs("doc", 16));
    await sleep(50);
    process.kill(pid!, "SIGKILL");
    await expect(pending).rejects.toBeInstanceOf(ProviderUnavailableError);
    const [v] = await a.embedQueries(["again"]);
    expect(vec(v)).toEqual(vec(fakeVector("again")));
    const [next] = hostPids();
    expect(next).not.toBe(pid);
    expect(a.shared).toBe(true);
  });

  it("falls back to a private inference process when the host does not start", async () => {
    const broken = join(dir, "not-a-dir");
    writeFileSync(broken, "");
    const a = make({ CODE_EMBED_CACHE_DIR: broken }, { startTimeoutMs: 1500 });
    const [v] = await a.embedQueries(["fallback"]);
    expect(vec(v)).toEqual(vec(fakeVector("fallback")));
    expect(a.shared).toBe(false);
    expect(spawns()).toHaveLength(1);
  });

  it("exits when no clients remain", async () => {
    const a = make({}, { idleExitMs: 200 });
    await a.embedQueries(["x"]);
    const [pid] = hostPids();
    const [worker] = spawns();
    await a.dispose();
    expect(await waitDead(pid!)).toBe(true);
    expect(await waitDead(worker!)).toBe(true);
    expect(hostPids()).toHaveLength(0);
  });

  it("rejects calls after dispose", async () => {
    const a = make();
    await a.dispose();
    await expect(a.embedQueries(["x"])).rejects.toThrow("embedder disposed");
    await expect(a.init()).rejects.toThrow("embedder disposed");
  });
});
