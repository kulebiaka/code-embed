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

export interface WorkerSpawnOptions {
  modulePath?: string;
  args?: string[];
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
}

const DOC_REQUEST_TEXTS = 8;
const DOC_REQUEST_CHARS = 4096;
const MAX_CRASHES = 3;
const BLOCK_MS = 600_000;
const KILL_AFTER_MS = 2000;

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
  out: Float32Array[];
  pending: number;
  resolve(v: Float32Array[]): void;
  reject(e: unknown): void;
  detach?: () => void;
}

interface Job {
  call: Call;
  indices: number[];
  kind: "query" | "document";
  texts: string[];
  prio: number;
  seq: number;
}

interface Inflight {
  id: number;
  job?: Job;
  resolve(v: Float32Array[] | undefined): void;
  reject(e: unknown): void;
}

function toError(e: { name: string; message: string; retryAfterMs?: number }): Error {
  return e.name === "ProviderUnavailableError" ? new ProviderUnavailableError(e.message, e.retryAfterMs) : new Error(e.message);
}

function splitDocuments(texts: string[]): number[][] {
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

export function createWorkerEmbedder(entry: ModelEntry, opts: LocalEmbedderOptions, spawn: WorkerSpawnOptions = {}): Embedder {
  const info = createLocalEmbedder(entry, opts).info;

  let child: ChildProcess | undefined;
  let ready = false;
  let initP: Promise<void> | undefined;
  let inflight: Inflight | undefined;
  const queue: Job[] = [];
  let crashes = 0;
  let blockedUntil = 0;
  let seq = 0;
  let nextId = 0;

  const finish = (call: Call, err?: unknown) => {
    if (call.done) return;
    call.done = true;
    call.detach?.();
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

  const onDead = (c: ChildProcess, err: Error) => {
    if (child !== c) return;
    child = undefined;
    ready = false;
    initP = undefined;
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

  const request = (c: ChildProcess, msg: RequestBody, job?: Job): Promise<Float32Array[] | undefined> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      inflight = { id, job, resolve, reject };
      c.send({ ...msg, id }, (err) => {
        if (err && inflight?.id === id) {
          inflight = undefined;
          reject(err);
        }
      });
    });

  const boot = async (): Promise<void> => {
    if (crashes >= MAX_CRASHES) {
      if (Date.now() < blockedUntil) {
        throw new ProviderUnavailableError("local inference process keeps crashing; not restarting for 10 minutes", BLOCK_MS);
      }
      crashes = 0;
    }
    const c = spawnChild();
    child = c;
    try {
      await request(c, { op: "init", model: entry.id, opts });
    } catch (err) {
      if (child === c) {
        child = undefined;
        ready = false;
        void terminate(c);
        failAll(err);
      }
      throw err;
    }
    if (child !== c) throw new ProviderUnavailableError("local inference process was stopped");
    ready = true;
    pump();
  };

  const start = (): Promise<void> => {
    if (initP) return initP;
    const p = boot();
    initP = p;
    p.catch(() => {
      if (initP === p) initP = undefined;
    });
    return p;
  };

  const pump = () => {
    if (queue.length === 0) return;
    if (!child) {
      start().catch((err) => failAll(err));
      return;
    }
    if (!ready || inflight) return;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i]!;
      const b = queue[best]!;
      if (a.prio < b.prio || (a.prio === b.prio && a.seq < b.seq)) best = i;
    }
    const job = queue.splice(best, 1)[0]!;
    request(child, { op: "embed", kind: job.kind, texts: job.texts }, job).then(
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

  const run = (
    kind: "query" | "document",
    total: number,
    groups: { indices: number[]; texts: string[]; prio: number }[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const call: Call = { done: false, out: new Array<Float32Array>(total), pending: groups.length, resolve, reject };
      if (signal) {
        const onAbort = () => finish(call, signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        call.detach = () => signal.removeEventListener("abort", onAbort);
      }
      for (const g of groups) queue.push({ call, kind, indices: g.indices, texts: g.texts, prio: g.prio, seq: seq++ });
      pump();
    });
  };

  const abortable = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  return {
    info,
    init: (signal) => abortable(start(), signal),
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
    async dispose() {
      const c = child;
      child = undefined;
      ready = false;
      initP = undefined;
      failAll(new Error("embedder disposed"));
      if (c) await terminate(c);
    },
  };
}
