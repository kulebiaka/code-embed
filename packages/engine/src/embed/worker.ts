import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { constants, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProviderUnavailableError } from "../errors";
import { log, type LogLevel } from "../util/log";
import { createLocalEmbedder, type LocalEmbedderOptions } from "./local";
import type { Embedder, ModelEntry } from "./types";
import type { WorkerRequest, WorkerResponse } from "./worker-child";

export interface InferencePoolOptions extends WorkerSpawnOptions {
  threads: number;
}

export interface InferencePool {
  embedder(entry: ModelEntry, loadOpts: LocalEmbedderOptions): Embedder;
  setThreads(n: number): Promise<void>;
  readonly threads: number;
  dispose(): Promise<void>;
}

export interface WorkerSpawnOptions {
  modulePath?: string;
  args?: string[];
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  idleUnloadMs?: number;
}

const DOC_REQUEST_TEXTS = 8;
const DOC_REQUEST_CHARS = 4096;
const MAX_CRASHES = 3;
const BLOCK_MS = 600_000;
const KILL_AFTER_MS = 2000;
const IDLE_UNLOAD_MS = 5 * 60_000;

const PRIO_QUERY = 0;
const PRIO_INTERACTIVE = 1;
const PRIO_BATCH = 2;

const LOG_LINE = /^\[code-embed\] (debug|info|warn|error): (.*)$/;

export function tsxExecArgv(): string[] {
  const loader = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs");
  return ["--import", pathToFileURL(loader).href];
}

function defaultSpawn(): Required<Pick<WorkerSpawnOptions, "modulePath" | "args" | "execArgv">> {
  if (import.meta.url.endsWith(".js")) {
    return { modulePath: fileURLToPath(import.meta.url), args: ["__embed-worker"], execArgv: [] };
  }
  return {
    modulePath: fileURLToPath(new URL("./worker-child.ts", import.meta.url)),
    args: [],
    execArgv: tsxExecArgv(),
  };
}

type RequestBody = WorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

interface Call {
  done: boolean;
  owner: Set<Call>;
  out: Float32Array[];
  pending: number;
  resolve(v: Float32Array[]): void;
  reject(e: unknown): void;
  detach?: () => void;
}

interface Job {
  model: string;
  opts: LocalEmbedderOptions;
  call: Call;
  indices: number[];
  kind: "query" | "document" | "load";
  texts: string[];
  prio: number;
  seq: number;
}

interface Inflight {
  id: number;
  model: string;
  job?: Job;
  resolve(v: Float32Array[] | undefined): void;
  reject(e: unknown): void;
}

export function toError(e: { name: string; message: string; retryAfterMs?: number }): Error {
  return e.name === "ProviderUnavailableError" ? new ProviderUnavailableError(e.message, e.retryAfterMs) : new Error(e.message);
}

export function splitDocuments(texts: string[]): number[][] {
  const order = texts.map((_, i) => i).sort((a, b) => texts[a]!.length - texts[b]!.length);
  const groups: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  for (const i of order) {
    const len = texts[i]!.length;
    if (cur.length > 0 && (cur.length >= DOC_REQUEST_TEXTS || chars + len > DOC_REQUEST_CHARS)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += len;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

interface ModelState {
  id: string;
  loaded: boolean;
  timer?: ReturnType<typeof setTimeout>;
  unloadMode?: "idle" | "explicit";
  unloadWaiters: (() => void)[];
}

export function createInferencePool(o: InferencePoolOptions): InferencePool {
  const spawn: WorkerSpawnOptions = o;
  let threads = o.threads;
  let child: ChildProcess | undefined;
  let inflight: Inflight | undefined;
  const queue: Job[] = [];
  const models = new Map<string, ModelState>();
  let disposed = false;
  let crashes = 0;
  let blockedUntil = 0;
  let seq = 0;
  let nextId = 0;
  let pendingThreads: number | undefined;
  let stopping: Promise<void> | undefined;
  let restartWaiters: (() => void)[] = [];

  const state = (id: string): ModelState => {
    let m = models.get(id);
    if (!m) {
      m = { id, loaded: false, unloadWaiters: [] };
      models.set(id, m);
    }
    return m;
  };

  const loadedCount = () => {
    let n = 0;
    for (const m of models.values()) if (m.loaded) n++;
    return n;
  };

  const hasWork = (model: string) => queue.some((j) => j.model === model) || inflight?.model === model;

  const clearTimer = (m: ModelState) => {
    if (m.timer) clearTimeout(m.timer);
    m.timer = undefined;
  };

  const settleUnload = (m: ModelState) => {
    m.unloadMode = undefined;
    for (const w of m.unloadWaiters.splice(0)) w();
  };

  const finish = (call: Call, err?: unknown) => {
    if (call.done) return;
    call.done = true;
    call.detach?.();
    call.owner.delete(call);
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.call === call) queue.splice(i, 1);
    if (err !== undefined) call.reject(err);
    else call.resolve(call.out);
  };

  const failAll = (err: unknown) => {
    const cur = inflight;
    inflight = undefined;
    cur?.reject(err);
    if (cur?.job) finish(cur.job.call, err);
    for (const job of [...queue]) finish(job.call, err);
  };

  const terminate = (c: ChildProcess): Promise<void> =>
    new Promise((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve();
      const timer = setTimeout(() => c.kill("SIGKILL"), KILL_AFTER_MS);
      timer.unref();
      c.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        c.disconnect();
      } catch {
        c.kill("SIGKILL");
      }
    });

  const forgetModels = () => {
    for (const m of models.values()) {
      m.loaded = false;
      clearTimer(m);
      settleUnload(m);
    }
  };

  const dropChild = (): Promise<void> => {
    const c = child;
    child = undefined;
    forgetModels();
    return c ? terminate(c) : Promise.resolve();
  };

  const stopChild = () => {
    const p = dropChild().then(() => {
      if (stopping === p) stopping = undefined;
      pump();
    });
    stopping = p;
  };

  const onDead = (c: ChildProcess, err: Error) => {
    if (child !== c) return;
    child = undefined;
    forgetModels();
    if (++crashes >= MAX_CRASHES) blockedUntil = Date.now() + BLOCK_MS;
    failAll(err);
  };

  const onMessage = (c: ChildProcess, res: WorkerResponse) => {
    if (child !== c || !inflight || inflight.id !== res.id) return;
    const cur = inflight;
    inflight = undefined;
    if (res.ok) {
      if (cur.job) crashes = 0;
      cur.resolve(res.result);
    } else {
      cur.reject(toError(res.error));
    }
    pump();
  };

  const spawnChild = (): ChildProcess => {
    const d = defaultSpawn();
    const c = fork(spawn.modulePath ?? d.modulePath, spawn.args ?? (spawn.modulePath ? [] : d.args), {
      execArgv: spawn.execArgv ?? (spawn.modulePath ? [] : d.execArgv),
      env: spawn.env ?? process.env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    if (c.pid !== undefined) {
      try {
        setPriority(c.pid, constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // priority is best-effort
      }
    }
    if (c.stderr) {
      createInterface({ input: c.stderr }).on("line", (line) => {
        const m = LOG_LINE.exec(line);
        if (m) log[m[1] as LogLevel](`[inference] ${m[2]}`);
        else if (line.trim()) log.warn(`[inference] ${line}`);
      });
    }
    c.on("message", (res: WorkerResponse) => onMessage(c, res));
    c.on("exit", (code, signal) =>
      onDead(c, new ProviderUnavailableError(`local inference process exited (${signal ? `signal ${signal}` : `code ${code}`})`)),
    );
    c.on("error", (e) => onDead(c, new ProviderUnavailableError(`local inference process error: ${e.message}`)));
    return c;
  };

  const request = (c: ChildProcess, msg: RequestBody, model: string, job?: Job): Promise<Float32Array[] | undefined> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      inflight = { id, model, job, resolve, reject };
      c.send({ ...msg, id }, (err) => {
        if (err && inflight?.id === id) {
          inflight = undefined;
          reject(err);
        }
      });
    });

  const ensureChild = (): ChildProcess | undefined => {
    if (child) return child;
    if (crashes >= MAX_CRASHES) {
      if (Date.now() < blockedUntil) {
        failAll(new ProviderUnavailableError("local inference process keeps crashing; not restarting for 10 minutes", BLOCK_MS));
        return undefined;
      }
      crashes = 0;
    }
    child = spawnChild();
    return child;
  };

  const loadModel = (c: ChildProcess, job: Job) => {
    const m = state(job.model);
    request(c, { op: "load", model: job.model, opts: { ...job.opts, threads } }, job.model).then(
      () => {
        if (child !== c) return;
        m.loaded = true;
        pump();
      },
      (err) => {
        if (child !== c) return;
        for (const j of [...queue]) if (j.model === job.model) finish(j.call, err);
        pump();
      },
    );
  };

  const unloadModel = (c: ChildProcess, m: ModelState) => {
    const done = () => {
      if (child === c) m.loaded = false;
      settleUnload(m);
      pump();
    };
    request(c, { op: "unload", model: m.id }, m.id).then(done, done);
  };

  const pump = () => {
    if (disposed) return;
    for (const m of models.values()) {
      if (!m.loaded) continue;
      if (m.unloadMode === "idle" && hasWork(m.id)) m.unloadMode = undefined;
      if (hasWork(m.id)) clearTimer(m);
      else if (!m.timer && !m.unloadMode) {
        m.timer = setTimeout(() => {
          m.timer = undefined;
          if (!m.loaded || hasWork(m.id)) return;
          m.unloadMode ??= "idle";
          pump();
        }, spawn.idleUnloadMs ?? IDLE_UNLOAD_MS);
        m.timer.unref();
      }
    }
    if (inflight || stopping) return;
    if (pendingThreads !== undefined) {
      threads = pendingThreads;
      pendingThreads = undefined;
      if (child) {
        stopChild();
        return;
      }
    }
    for (const w of restartWaiters.splice(0)) w();
    const c = child;
    if (c) {
      for (const m of models.values()) {
        if (!m.unloadMode || hasWork(m.id)) continue;
        if (m.loaded) {
          clearTimer(m);
          unloadModel(c, m);
          return;
        }
        settleUnload(m);
      }
    }
    if (queue.length === 0) {
      if (c && loadedCount() === 0) stopChild();
      return;
    }
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i]!;
      const b = queue[best]!;
      if (a.prio < b.prio || (a.prio === b.prio && a.seq < b.seq)) best = i;
    }
    const job = queue[best]!;
    const target = ensureChild();
    if (!target) return;
    if (!state(job.model).loaded) {
      loadModel(target, job);
      return;
    }
    queue.splice(best, 1);
    if (job.kind === "load") {
      finish(job.call);
      pump();
      return;
    }
    request(target, { op: "embed", model: job.model, kind: job.kind, texts: job.texts }, job.model, job).then(
      (vecs) => {
        if (job.call.done) return;
        job.indices.forEach((pos, k) => {
          job.call.out[pos] = vecs![k]!;
        });
        if (--job.call.pending === 0) finish(job.call);
      },
      (err) => finish(job.call, err),
    );
  };

  return {
    get threads() {
      return threads;
    },
    setThreads(n) {
      if (disposed) return Promise.resolve();
      if (pendingThreads === undefined && n === threads && !stopping) return Promise.resolve();
      pendingThreads = n;
      const done = new Promise<void>((r) => restartWaiters.push(r));
      pump();
      return done;
    },
    embedder(entry, loadOpts) {
      const info = createLocalEmbedder(entry, loadOpts).info;
      const model = entry.id;
      const calls = new Set<Call>();
      let handleDisposed = false;
      state(model);

      const run = (
        kind: Job["kind"],
        total: number,
        groups: { indices: number[]; texts: string[]; prio: number }[],
        signal?: AbortSignal,
      ): Promise<Float32Array[]> => {
        if (disposed || handleDisposed) return Promise.reject(new Error("embedder disposed"));
        if (signal?.aborted) return Promise.reject(signal.reason);
        return new Promise((resolve, reject) => {
          const call: Call = { done: false, owner: calls, out: new Array<Float32Array>(total), pending: groups.length, resolve, reject };
          calls.add(call);
          if (signal) {
            const onAbort = () => finish(call, signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            call.detach = () => signal.removeEventListener("abort", onAbort);
          }
          for (const g of groups) {
            queue.push({ model, opts: loadOpts, call, kind, indices: g.indices, texts: g.texts, prio: g.prio, seq: seq++ });
          }
          pump();
        });
      };

      return {
        info,
        async init(signal) {
          await run("load", 0, [{ indices: [], texts: [], prio: PRIO_QUERY }], signal);
        },
        async embedQueries(texts, signal) {
          if (texts.length === 0) return [];
          return run("query", texts.length, [{ indices: texts.map((_, i) => i), texts, prio: PRIO_QUERY }], signal);
        },
        async embedDocuments(texts, signal) {
          if (texts.length === 0) return [];
          const groups = splitDocuments(texts);
          const prio = groups.length === 1 ? PRIO_INTERACTIVE : PRIO_BATCH;
          return run(
            "document",
            texts.length,
            groups.map((indices) => ({ indices, texts: indices.map((i) => texts[i]!), prio })),
            signal,
          );
        },
        countTokens: (text) => Math.ceil(text.length / 4),
        async unload() {
          const m = state(model);
          if (!m.loaded || disposed) return;
          const wait = hasWork(model) ? undefined : new Promise<void>((r) => m.unloadWaiters.push(r));
          m.unloadMode = "explicit";
          pump();
          await wait;
        },
        async dispose() {
          handleDisposed = true;
          for (const call of [...calls]) finish(call, new Error("embedder disposed"));
        },
      };
    },
    async dispose() {
      disposed = true;
      for (const m of models.values()) {
        clearTimer(m);
        settleUnload(m);
      }
      failAll(new Error("embedder disposed"));
      pendingThreads = undefined;
      for (const w of restartWaiters.splice(0)) w();
      await stopping;
      await dropChild();
    },
  };
}

export function createWorkerEmbedder(entry: ModelEntry, opts: LocalEmbedderOptions, spawn: WorkerSpawnOptions = {}): Embedder {
  const pool = createInferencePool({ ...spawn, threads: opts.threads });
  const handle = pool.embedder(entry, opts);
  return {
    ...handle,
    async dispose() {
      await handle.dispose();
      await pool.dispose();
    },
  };
}
