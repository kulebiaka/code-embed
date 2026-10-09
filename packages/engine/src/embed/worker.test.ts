import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../config/types";
import { ProviderUnavailableError } from "../errors";
import { getModel } from "./catalog";
import type { Embedder } from "./types";
import { createWorkerEmbedder, tsxExecArgv } from "./worker";

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
const tmp: string[] = [];

function make(env: Record<string, string> = {}): Embedder {
  const e = createWorkerEmbedder(getModel(DEFAULTS.model), OPTS, {
    modulePath: FIXTURE,
    execArgv: tsxExecArgv(),
    env: { ...process.env, ...env },
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

  it("terminates the child on dispose and can start a new one afterwards", async () => {
    const log = spawnLog();
    const e = make({ FIXTURE_SPAWN_LOG: log });
    await e.init();
    const [pid] = spawns(log);
    await e.dispose();
    expect(() => process.kill(pid!, 0)).toThrow();
    await e.embedQueries(["again"]);
    expect(spawns(log)).toHaveLength(2);
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
