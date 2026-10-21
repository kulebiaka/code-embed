import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type IndexProgress, type SearchResponse } from "@code-embed/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultThreads } from "../config/resolve";
import { FakeEmbedder } from "../embed/fake";
import * as registry from "../embed/registry";
import { NoIndexError, ProtocolMismatchError } from "../errors";
import { log } from "../util/log";
import { SERVER_VERSION, createLocalEngine } from "./service";
import type { LocalEngine, LocalEngineOptions } from "./types";

vi.mock("../embed/registry", async (orig) => {
  const actual = await orig<typeof import("../embed/registry")>();
  return { ...actual, resolveEmbedder: vi.fn(actual.resolveEmbedder) };
});

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let engines: LocalEngine[];

function makeRepo(name = "repo"): string {
  const dir = join(tmp, name);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

async function open(root: string, extra: Partial<LocalEngineOptions> = {}): Promise<LocalEngine> {
  const e = await createLocalEngine({
    root,
    clientName: "test",
    cli: { indexLocation: "project" },
    ...extra,
  });
  engines.push(e);
  return e;
}

const REFUND_METHOD_LINE = 64;

function containsRefundMethod(res: SearchResponse): boolean {
  return res.results.some(
    (r) =>
      r.path === "src/payment/refund.ts" &&
      r.range.startLine <= REFUND_METHOD_LINE &&
      r.range.endLine >= REFUND_METHOD_LINE,
  );
}

const INIT = { root: "", clientName: "test", protocolVersion: PROTOCOL_VERSION };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-engine-"));
  mkdirSync(join(tmp, "cache"));
  mkdirSync(join(tmp, "config"));
  vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "config"));
  vi.stubEnv("CODE_EMBED_FAKE_EMBEDDER", "1");
  vi.stubEnv("CODE_EMBED_FAKE_DIMS", "64");
  engines = [];
});

afterEach(async () => {
  for (const e of engines) await e.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("LocalEngine", () => {
  it("initialize -> indexAll -> hybrid search; partial before vectors", async () => {
    const root = makeRepo();
    const engine = await open(root);
    const init = await engine.initialize({ ...INIT, root });
    expect(init.serverVersion).toBe(SERVER_VERSION);
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.capabilities).toMatchObject({ search: true, findSimilar: true, readOnly: false });

    await engine.ensureLexical();
    const before = await engine.search({ query: "refund payment" });
    expect(before.partial).toBe(true);
    expect(containsRefundMethod(before)).toBe(true);

    await engine.indexAll({});
    const st = await engine.status();
    expect(st.files).toBeGreaterThan(0);
    expect(st.embedded).toBe(st.chunks);
    expect(st.lexicalOnly).toBe(false);
    expect(st.model).toBe("fake/fake@64");

    const after = await engine.search({ query: "refund payment", mode: "hybrid" });
    expect(after.partial).toBe(false);
    expect(containsRefundMethod(after)).toBe(true);

    const sim = await engine.findSimilar({ code: "function processPaymentRefund(order) {}", lang: "typescript" });
    expect(sim.results.length).toBeGreaterThan(0);
  });

  it("rejects a mismatched protocol version", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await expect(engine.initialize({ ...INIT, root, protocolVersion: 999 })).rejects.toBeInstanceOf(
      ProtocolMismatchError,
    );
  });

  it("readonly without an index throws NoIndexError with a hint and writes nothing", async () => {
    const root = makeRepo();
    const err = await createLocalEngine({
      root,
      clientName: "t",
      readonly: true,
      cli: { indexLocation: "project" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NoIndexError);
    expect(err.message).toContain("code-embed index");
    expect(existsSync(join(root, ".code-embed"))).toBe(false);
  });

  it("readonly engine searches an existing index and refuses writes", async () => {
    const root = makeRepo();
    const writer = await open(root);
    await writer.ensureLexical();
    await writer.close();
    const ro = await open(root, { readonly: true });
    expect((await ro.status()).readOnly).toBe(true);
    expect((await ro.search({ query: "processPaymentRefund" })).results.length).toBeGreaterThan(0);
    await expect(ro.rebuild()).rejects.toMatchObject({ code: -32005 });
    await expect(ro.indexAll({})).rejects.toMatchObject({ code: -32005 });
    expect(await ro.quickUpdate(100)).toEqual({ complete: true });
  });

  it("ensureLexical builds a missing index without starting the vector phase", async () => {
    const root = makeRepo();
    const engine = await open(root);
    expect((await engine.status()).chunks).toBe(0);
    await engine.ensureLexical();
    const st = await engine.status();
    expect(st.chunks).toBeGreaterThan(0);
    expect(st.embedded).toBe(0);
  });

  it("quickUpdate picks up changed files", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.ensureLexical();
    writeFileSync(join(root, "src/extra.ts"), "export function zebraUnicornHandler() { return 1; }\n");
    expect(await engine.quickUpdate(5000)).toEqual({ complete: true });
    const r = await engine.search({ query: "zebraUnicornHandler", mode: "lexical" });
    expect(r.results[0]?.path).toBe("src/extra.ts");
  });

  it("filesChanged without watcher applies changes directly", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.ensureLexical();
    const file = join(root, "src/late.ts");
    writeFileSync(file, "export function quokkaPipeline() { return 2; }\n");
    engine.filesChanged({ created: [file], changed: [], deleted: [] });
    await vi.waitFor(async () => {
      const r = await engine.search({ query: "quokkaPipeline", mode: "lexical" });
      expect(r.results.length).toBeGreaterThan(0);
    });
    rmSync(file);
    engine.filesChanged({ created: [], changed: [], deleted: [file] });
    await vi.waitFor(async () => {
      const r = await engine.search({ query: "quokkaPipeline", mode: "lexical" });
      expect(r.results.length).toBe(0);
    });
  });

  it("a background engine defers changes until it is active or searched", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.ensureLexical();
    engine.setActive({ active: false });
    const file = join(root, "src/late.ts");
    writeFileSync(file, "export function quokkaPipeline() { return 2; }\n");
    engine.filesChanged({ created: [file], changed: [], deleted: [] });
    await new Promise((r) => setTimeout(r, 200));
    const before = (await engine.status()).files;
    engine.setActive({ active: true });
    await vi.waitFor(async () => expect((await engine.status()).files).toBe(before + 1));

    engine.setActive({ active: false });
    rmSync(file);
    engine.filesChanged({ created: [], changed: [], deleted: [file] });
    await new Promise((r) => setTimeout(r, 200));
    expect((await engine.status()).files).toBe(before + 1);
    const r = await engine.search({ query: "quokkaPipeline", mode: "lexical" });
    expect(r.results).toHaveLength(0);
  });

  it("a background start embeds pending chunks but skips the scan until active", async () => {
    const root = makeRepo();
    const first = await open(root);
    await first.ensureLexical();
    await first.close();
    writeFileSync(join(root, "src/extra.ts"), "export function zebraUnicornHandler() { return 1; }\n");
    const engine = await open(root, { vectorPhase: true, active: false });
    await vi.waitFor(async () => {
      const st = await engine.status();
      expect(st.chunks).toBeGreaterThan(0);
      expect(st.embedded).toBe(st.chunks);
    });
    const files = (await engine.status()).files;
    engine.setActive({ active: true });
    await vi.waitFor(async () => expect((await engine.status()).files).toBe(files + 1));
  });

  it("filesOpened and pause/resume do not break indexing", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.ensureLexical();
    engine.filesOpened({ paths: [join(root, "src/payment/refund.ts")] });
    await engine.pause();
    expect((await engine.status()).phase).toBe("paused");
    await engine.resume();
    await engine.indexAll({});
    const st = await engine.status();
    expect(st.embedded).toBe(st.chunks);
  });

  it("forwards progress and logs to listeners", async () => {
    const root = makeRepo();
    const engine = await open(root);
    const progress: IndexProgress[] = [];
    const logs: string[] = [];
    engine.onProgress((p) => progress.push(p));
    engine.onLog((l) => logs.push(l.message));
    log.warn("hello from test");
    await engine.indexAll({});
    expect(logs).toContain("hello from test");
    expect(progress.length).toBeGreaterThan(0);
  });

  it("consent-required provider degrades to lexical-only until consent is granted", async () => {
    vi.stubEnv("CODE_EMBED_FAKE_EMBEDDER", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const input = JSON.parse(init.body).input as string[];
        return new Response(
          JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: [1, 0, 0, i + 1] })) }),
        );
      }),
    );
    const root = makeRepo();
    const engine = await open(root, {
      settings: {
        embedding: { provider: "cloud" },
        providers: {
          cloud: { kind: "openai", base_url: "https://embeddings.example.com/v1", model: "m", dimensions: 4 },
        },
      },
    });
    await engine.ensureLexical();
    const st = await engine.status();
    expect(st.lexicalOnly).toBe(true);
    expect(st.remote).toBe(true);
    expect(st.host).toBe("embeddings.example.com");
    expect(st.consentRequired).toEqual({ host: "embeddings.example.com", provider: "cloud" });
    const r = await engine.search({ query: "refund payment" });
    expect(r.partial).toBe(true);
    expect(r.partialReason).toBeTruthy();
    expect(r.results.length).toBeGreaterThan(0);
    await expect(engine.indexAll({})).rejects.toThrow(/consent/);

    await engine.grantConsent({ host: "embeddings.example.com" });
    const after = await engine.status();
    expect(after.consentRequired).toBeUndefined();
    expect(after.lexicalOnly).toBe(false);
    await vi.waitFor(async () => {
      const s = await engine.status();
      expect(s.chunks).toBeGreaterThan(0);
      expect(s.embedded).toBe(s.chunks);
    });
  });

  it("changing the model rebuilds only vectors", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.indexAll({});
    const before = await engine.status();
    expect(before.model).toBe("fake/fake@64");

    vi.stubEnv("CODE_EMBED_FAKE_DIMS", "32");
    await engine.updateSettings({ model: { id: "other-model" } });
    const mid = await engine.status();
    expect(mid.files).toBe(before.files);
    expect(mid.chunks).toBe(before.chunks);
    expect(mid.model).toBe("fake/fake@32");
    const lexical = await engine.search({ query: "processPaymentRefund", mode: "lexical" });
    expect(lexical.results.length).toBeGreaterThan(0);
    await vi.waitFor(async () => {
      const s = await engine.status();
      expect(s.embedded).toBe(s.chunks);
    });
  });

  it("concurrent settings changes leave exactly one live embedder and vector phase", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.indexAll({});

    const { resolveEmbedder: actual } = await vi.importActual<typeof registry>("../embed/registry");
    const created: { embedder: FakeEmbedder; disposed: boolean; calls: number }[] = [];
    vi.mocked(registry.resolveEmbedder).mockImplementation(async (o) => {
      const e = (await actual(o)) as FakeEmbedder;
      const rec = { embedder: e, disposed: false, calls: 0 };
      created.push(rec);
      const dispose = e.dispose.bind(e);
      e.dispose = async () => {
        rec.disposed = true;
        await dispose();
      };
      const embedDocuments = e.embedDocuments.bind(e);
      e.embedDocuments = (texts, signal) => {
        rec.calls++;
        return embedDocuments(texts, signal);
      };
      return e;
    });

    vi.stubEnv("CODE_EMBED_FAKE_DIMS", "32");
    await Promise.all([1, 2, 3].map((threads) => engine.updateSettings({ index: { threads } })));

    expect(created).toHaveLength(3);
    expect(created.slice(0, -1).every((r) => r.disposed)).toBe(true);
    expect(created.at(-1)!.disposed).toBe(false);
    await vi.waitFor(async () => {
      const s = await engine.status();
      expect(s.embedded).toBe(s.chunks);
    });
    expect(created.at(-1)!.calls).toBeGreaterThan(0);
    const stale = created.slice(0, 2).map((r) => r.calls);
    await engine.updateSettings({ model: { id: "other-model" } });
    await vi.waitFor(async () => {
      const s = await engine.status();
      expect(s.embedded).toBe(s.chunks);
    });
    expect(created.slice(0, 2).map((r) => r.calls)).toEqual(stale);
  });

  it("recreates the embedder when threads become explicit with the default value", async () => {
    const root = makeRepo();
    const engine = await open(root);
    await engine.indexAll({});
    const resolve = vi.mocked(registry.resolveEmbedder);
    const before = resolve.mock.calls.length;
    await engine.updateSettings({ index: { threads: defaultThreads() } });
    expect(resolve.mock.calls.length).toBe(before + 1);
    expect(resolve.mock.calls.at(-1)![0]).toMatchObject({ settings: { threadsExplicit: true } });
  });

  it("lists providers and models, and tests a provider", async () => {
    const root = makeRepo();
    const engine = await open(root, {
      settings: {
        providers: { lan: { kind: "openai", base_url: "http://127.0.0.1:9/v1", model: "m" } },
      },
    });
    const providers = await engine.listProviders();
    expect(providers[0]).toMatchObject({ name: "local", source: "builtin", remote: false });
    expect(providers.find((p) => p.name === "lan")).toMatchObject({ source: "editor", remote: false });
    const models = await engine.listModels();
    expect(models.filter((m) => m.isDefault)).toHaveLength(1);
    expect(models.every((m) => typeof m.installed === "boolean")).toBe(true);
    const t = await engine.testProvider({ name: "local" });
    expect(t.dims).toBe(64);
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("export/import: imported vectors are used without inference", async () => {
    const rootA = makeRepo("a");
    const a = await open(rootA);
    await a.indexAll({});
    const file = join(tmp, "vectors.bin");
    const exported = await a.exportVectors(file);
    expect(exported.count).toBeGreaterThan(0);
    await a.close();

    vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache2"));
    const rootB = makeRepo("b");
    const b = await open(rootB);
    await b.ensureLexical();
    const imported = await b.importVectors(file);
    expect(imported.count).toBe(exported.count);

    const spy = vi.spyOn(FakeEmbedder.prototype, "embedDocuments");
    await b.indexAll({});
    expect(spy).not.toHaveBeenCalled();
    const st = await b.status();
    expect(st.embedded).toBe(st.chunks);
  });

  it("bounds query embedding by a timeout only while the vector phase is running", async () => {
    const root = makeRepo();
    const first = await open(root);
    await first.indexAll({});
    await first.close();
    writeFileSync(join(root, "src/extra.ts"), "export function quokkaExtra() {\n  return 42;\n}\n");

    vi.mocked(registry.resolveEmbedder).mockImplementationOnce(async () => new FakeEmbedder({ dims: 64, latencyMs: 1500 }));
    const engine = await open(root, { vectorPhase: true });
    let res: SearchResponse | undefined;
    await vi.waitFor(async () => {
      const t = performance.now();
      res = await engine.search({ query: "refund payment" });
      expect(res.partialReason).toContain("timed out");
      expect(performance.now() - t).toBeLessThan(1400);
    }, { timeout: 10_000, interval: 50 });
    expect(res!.partial).toBe(true);
    expect(res!.results.length).toBeGreaterThan(0);
    expect(res!.results.every((r) => r.sources.join() === "lexical")).toBe(true);

    await engine.indexAll({});
    const after = await engine.search({ query: "refund payment" });
    expect(after.partial).toBe(false);
    expect(after.results.some((r) => r.sources.includes("semantic"))).toBe(true);
  }, 30_000);
});
