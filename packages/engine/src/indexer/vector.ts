import { getPriority, setPriority, constants } from "node:os";
import type { ChunkRecord } from "../store/types";
import type { EmbCache } from "../cache/types";
import { buildEmbeddingText } from "../chunk/header";
import type { Embedder } from "../embed/types";
import { ProviderUnavailableError } from "../errors";
import { quantizeInt8 } from "../store/quantize";
import { log } from "../util/log";
import { recentlyChangedPaths } from "./git";
import { isOnBattery } from "./power";
import { orderPaths, toStorePath } from "./queue";
import type { IndexerContext } from "./types";

export interface VectorPhase {
  start(): void;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  prioritize(paths: string[]): void;
  notifyChanged(paths: string[]): void;
  readonly state: "idle" | "running" | "paused" | "waiting-provider";
  whenIdle(): Promise<void>;
}

export interface VectorPhaseDeps {
  ctx: IndexerContext;
  embCache: EmbCache;
  embedder: Embedder;
  batchSize?: number;
  commitEvery?: number;
}

const GROUP = 16;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BATTERY_POLL_MS = 30_000;

type State = VectorPhase["state"];

function touch(list: string[], paths: string[]): void {
  for (const p of paths) {
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
  }
  list.unshift(...paths);
}

export function createVectorPhase(deps: VectorPhaseDeps): VectorPhase {
  const { ctx, embCache, embedder } = deps;
  const batchSize = deps.batchSize ?? 32;
  const commitEvery = deps.commitEvery ?? 8;
  const root = ctx.root;

  let state: State = "idle";
  let started = false;
  let stopped = false;
  let paused = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let idleWaiters: (() => void)[] = [];
  const abort = new AbortController();

  const opened: string[] = [];
  const changed: string[] = [];
  let gitRecent: string[] | null = null;
  let order: string[] = [];
  let cursor = 0;
  let dirty = true;

  const uncommitted = new Map<number, Int8Array>();
  let batchesSinceCommit = 0;
  let dimsReady = false;

  const setState = (s: State) => {
    state = s;
  };

  const progress = (phase: "vector" | "paused" | "idle" | "error") => {
    const c = ctx.store.counts();
    ctx.onProgress({ phase, done: c.embedded, total: c.chunks, embedded: c.embedded });
  };

  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const t = Number.isFinite(ms) ? setTimeout(done, ms) : null;
      function done() {
        if (t) clearTimeout(t);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const flush = () => {
    batchesSinceCommit = 0;
    if (uncommitted.size === 0) return;
    const items = [...uncommitted].map(([chunkId, vector]) => ({ chunkId, vector }));
    ctx.store.transaction(() => ctx.store.setEmbeddings(items));
    uncommitted.clear();
  };

  const nextBatch = (): ChunkRecord[] => {
    if (dirty) {
      const all = ctx.store.listFiles().map((f) => f.path);
      order = orderPaths(all, opened, [...changed, ...(gitRecent ?? [])]);
      cursor = 0;
      dirty = false;
    }
    while (cursor < order.length) {
      const group = order.slice(cursor, cursor + GROUP);
      const rows = ctx.store
        .pendingChunks(batchSize + uncommitted.size, group)
        .filter((c) => !uncommitted.has(c.id))
        .slice(0, batchSize);
      if (rows.length > 0) return rows;
      cursor += GROUP;
    }
    return [];
  };

  const processBatch = async (rows: ChunkRecord[]) => {
    const modelId = embedder.info.modelId;
    const hashes = [...new Set(rows.map((r) => r.chunkHash))];
    const vectors = embCache.get(modelId, hashes);
    const firstByHash = new Map<string, ChunkRecord>();
    for (const r of rows) if (!firstByHash.has(r.chunkHash)) firstByHash.set(r.chunkHash, r);
    const missing = hashes.filter((h) => !vectors.has(h));
    if (missing.length > 0) {
      const texts = missing.map((h) => {
        const r = firstByHash.get(h)!;
        return buildEmbeddingText(r, { path: r.path, lang: r.lang });
      });
      const out = await embedder.embedDocuments(texts, abort.signal);
      abort.signal.throwIfAborted();
      if (out.length !== missing.length) throw new Error(`embedder returned ${out.length} vectors for ${missing.length} texts`);
      const fresh = missing.map((chunkHash, i) => ({ chunkHash, vector: out[i]! }));
      embCache.put(modelId, fresh);
      for (const f of fresh) vectors.set(f.chunkHash, f.vector);
    }
    for (const r of rows) uncommitted.set(r.id, quantizeInt8(vectors.get(r.chunkHash)!));
    if (++batchesSinceCommit >= commitEvery) {
      flush();
      progress("vector");
    }
  };

  const prepare = async () => {
    await embedder.init(abort.signal);
    abort.signal.throwIfAborted();
    if (ctx.store.dims !== embedder.info.dims) ctx.store.setVectorDims(embedder.info.dims);
    dimsReady = true;
  };

  const run = async () => {
    const prevPriority = safe(() => getPriority(0));
    safe(() => setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL));
    let backoff = BACKOFF_START_MS;
    let batteryAt = 0;
    let onBattery = false;
    await Promise.resolve();
    try {
      gitRecent ??= await recentlyChangedPaths(root);
      for (;;) {
        if (stopped) break;
        if (paused) {
          flush();
          progress("paused");
          setState("paused");
          await nap(Infinity);
          continue;
        }
        if (ctx.settings.pauseOnBattery) {
          if (Date.now() - batteryAt > BATTERY_POLL_MS || onBattery) {
            onBattery = await isOnBattery();
            batteryAt = Date.now();
            if (stopped) break;
          }
          if (onBattery) {
            flush();
            progress("paused");
            setState("paused");
            await nap(BATTERY_POLL_MS);
            continue;
          }
        }
        setState("running");
        try {
          if (!dimsReady) await prepare();
          const rows = nextBatch();
          if (rows.length === 0) break;
          await processBatch(rows);
          backoff = BACKOFF_START_MS;
        } catch (err) {
          if (stopped) break;
          if (err instanceof ProviderUnavailableError) {
            flush();
            setState("waiting-provider");
            ctx.onError({ message: `embedding provider unavailable: ${err.message}` });
            const delay = err.retryAfterMs ?? backoff;
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            await nap(delay);
            continue;
          }
          const message = err instanceof Error ? err.message : String(err);
          log.error(`vector phase failed: ${message}`);
          ctx.onError({ message: `vector phase failed: ${message}` });
          break;
        }
      }
    } finally {
      try {
        flush();
      } catch (err) {
        log.error(`vector commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (prevPriority !== undefined) safe(() => setPriority(0, prevPriority));
      loop = null;
      setState(paused && !stopped ? "paused" : "idle");
      try {
        progress(state === "paused" ? "paused" : "idle");
      } catch (err) {
        log.error(`vector progress failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (state === "idle") {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  };

  const kick = () => {
    if (!started || stopped || loop) return;
    setState(paused ? "paused" : "running");
    loop = run().catch((err) => {
      log.error(`vector loop crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    get state() {
      return state;
    },
    start() {
      started = true;
      kick();
    },
    async stop() {
      stopped = true;
      abort.abort();
      wake?.();
      await loop;
      setState("idle");
      for (const w of idleWaiters) w();
      idleWaiters = [];
    },
    pause() {
      paused = true;
      if (!loop && !stopped) setState("paused");
    },
    resume() {
      paused = false;
      if (state === "paused" && !loop && !stopped) setState("idle");
      wake?.();
      kick();
    },
    prioritize(paths) {
      touch(opened, paths.map((p) => toStorePath(root, p)));
      dirty = true;
      kick();
    },
    notifyChanged(paths) {
      touch(changed, paths.map((p) => toStorePath(root, p)));
      dirty = true;
      kick();
    },
    whenIdle() {
      if (!loop && state !== "paused") return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
