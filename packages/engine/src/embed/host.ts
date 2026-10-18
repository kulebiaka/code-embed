import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import pkg from "../../package.json";
import { acquireLock } from "../core/lock";
import { cacheDir, embedHostSocketPath } from "../core/paths";
import { blake3Hex, initHashing } from "../util/hash";
import { log } from "../util/log";
import { probeSocket } from "../util/socket";
import { getModel } from "./catalog";
import type { LocalEmbedderOptions } from "./local";
import { createWorkerEmbedder } from "./worker";

export const HOST_PROTOCOL_VERSION = 1;
const IDLE_EXIT_MS = 10 * 60_000;
const EMBED_ERROR = -32000;

export interface EmbedHostConfig {
  model: string;
  opts: LocalEmbedderOptions;
  // tests replace the inference child and shorten the timers
  worker?: { modulePath: string; execArgv: string[] };
  idleUnloadMs?: number;
  idleExitMs?: number;
}

export interface HelloParams {
  protocolVersion: number;
  modelId: string;
  threads: number;
  clientId: string;
  project?: string;
  active: boolean;
}

export interface HelloResult {
  dims: number;
  maxTokens: number;
}

export type EmbedPrio = "query" | "interactive" | "batch";

export interface EmbedParams {
  kind: "query" | "document";
  texts: string[];
  prio: EmbedPrio;
}

export interface EmbedResult {
  vectors: string[];
}

export interface EmbedErrorData {
  name: string;
  retryAfterMs?: number;
}

// Engine version is part of the key so that an updated extension or CLI never talks to an old host.
export function hostKey(cfg: EmbedHostConfig): string {
  return blake3Hex(JSON.stringify([HOST_PROTOCOL_VERSION, pkg.version, cfg])).slice(0, 16);
}

export function hostLockName(key: string): string {
  return `embed-host-${key}.lock`;
}

export function encodeVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function decodeVector(s: string): Float32Array {
  const bytes = Buffer.from(s, "base64");
  const v = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(v.buffer).set(bytes);
  return v;
}

export interface HostClient {
  active: boolean;
  served: number;
}

export interface BatchQueue {
  run<T>(client: HostClient, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

// One batch request at a time; active clients first, then the client served longest ago.
export function createBatchQueue(): BatchQueue {
  interface Task {
    client: HostClient;
    seq: number;
    start(): void;
  }
  const pending: Task[] = [];
  let running = false;
  let seq = 0;
  let tick = 0;

  const before = (a: Task, b: Task) => {
    if (a.client.active !== b.client.active) return a.client.active;
    if (a.client.served !== b.client.served) return a.client.served < b.client.served;
    return a.seq < b.seq;
  };

  const pump = () => {
    if (running || pending.length === 0) return;
    let best = 0;
    for (let i = 1; i < pending.length; i++) if (before(pending[i]!, pending[best]!)) best = i;
    const task = pending.splice(best, 1)[0]!;
    task.client.served = ++tick;
    running = true;
    task.start();
  };

  return {
    run(client, fn, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const i = pending.indexOf(task);
          if (i < 0) return;
          pending.splice(i, 1);
          reject(signal!.reason);
        };
        const task: Task = {
          client,
          seq: seq++,
          start() {
            signal?.removeEventListener("abort", onAbort);
            fn()
              .then(resolve, reject)
              .finally(() => {
                running = false;
                pump();
              });
          },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.push(task);
        pump();
      });
    },
  };
}

function toResponseError(err: unknown): ResponseError<EmbedErrorData> {
  const e = err instanceof Error ? err : new Error(String(err));
  const retryAfterMs = (e as { retryAfterMs?: number }).retryAfterMs;
  return new ResponseError(EMBED_ERROR, e.message, { name: e.name, retryAfterMs });
}

export async function runEmbedHost(cfg: EmbedHostConfig): Promise<void> {
  await initHashing();
  const key = hostKey(cfg);
  const sock = embedHostSocketPath(key);
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const lock = acquireLock(dir, hostLockName(key));
  if (!lock) {
    log.info(`embedding host ${key} is already running`);
    return;
  }

  const worker = createWorkerEmbedder(getModel(cfg.model), cfg.opts, {
    modulePath: cfg.worker?.modulePath,
    execArgv: cfg.worker?.execArgv,
    idleUnloadMs: cfg.idleUnloadMs,
  });
  const queue = createBatchQueue();
  const clients = new Set<Socket>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let stop: () => Promise<void> = async () => {};

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (stopped || clients.size > 0) return;
    idleTimer = setTimeout(() => {
      log.info("no clients; embedding host exits");
      void stop();
    }, cfg.idleExitMs ?? IDLE_EXIT_MS);
  };

  const embed = (p: EmbedParams, signal: AbortSignal) =>
    p.kind === "query" ? worker.embedQueries(p.texts, signal) : worker.embedDocuments(p.texts, signal);

  const isUnix = process.platform !== "win32";
  const other = await probeSocket(sock, 200);
  if (other) {
    other.destroy();
    await worker.dispose();
    lock.release();
    log.info(`embedding host ${key} is already listening`);
    return;
  }
  if (isUnix) {
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
    rmSync(sock, { force: true });
  }

  const server = createServer((socket) => {
    clients.add(socket);
    armIdle();
    socket.on("error", () => {});
    const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    const client: HostClient = { active: true, served: 0 };
    const aborts = new Set<AbortController>();
    let greeted = false;

    conn.onRequest("hello", (p: HelloParams): HelloResult => {
      if (p.protocolVersion !== HOST_PROTOCOL_VERSION || p.modelId !== cfg.model || p.threads !== cfg.opts.threads) {
        throw new ResponseError(
          ErrorCodes.InvalidRequest,
          `embedding host serves ${cfg.model} with ${cfg.opts.threads} threads, protocol ${HOST_PROTOCOL_VERSION}`,
        );
      }
      greeted = true;
      client.active = p.active;
      log.info(`client ${p.clientId} connected${p.project ? ` (${p.project})` : ""}`);
      return { dims: worker.info.dims, maxTokens: worker.info.maxInputTokens };
    });
    conn.onNotification("activity", (p: { active: boolean }) => {
      client.active = p.active;
    });
    conn.onRequest("embed", async (p: EmbedParams, token): Promise<EmbedResult> => {
      if (!greeted) throw new ResponseError(ErrorCodes.InvalidRequest, "hello is required first");
      const ac = new AbortController();
      aborts.add(ac);
      const sub = token.onCancellationRequested(() => ac.abort(new Error("cancelled")));
      try {
        const vecs =
          p.prio === "batch" ? await queue.run(client, () => embed(p, ac.signal), ac.signal) : await embed(p, ac.signal);
        return { vectors: vecs.map(encodeVector) };
      } catch (err) {
        throw toResponseError(err);
      } finally {
        sub.dispose();
        aborts.delete(ac);
      }
    });

    socket.once("close", () => {
      clients.delete(socket);
      for (const ac of aborts) ac.abort(new Error("client disconnected"));
      conn.dispose();
      armIdle();
    });
    conn.listen();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    await worker.dispose();
    lock.release();
    throw err;
  }
  if (isUnix) chmodSync(sock, 0o600);
  log.info(`embedding host listening on ${sock} (pid ${process.pid}, model ${cfg.model}, ${cfg.opts.threads} threads)`);
  armIdle();

  return new Promise<void>((resolve) => {
    let stopping: Promise<void> | null = null;
    const onSignal = () => void stop();
    stop = () => {
      stopping ??= (async () => {
        stopped = true;
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        if (idleTimer) clearTimeout(idleTimer);
        const closed = new Promise<void>((r) => server.close(() => r()));
        for (const c of clients) c.destroy();
        await closed;
        await worker.dispose();
        if (isUnix) rmSync(sock, { force: true });
        lock.release();
        resolve();
      })();
      return stopping;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry || !import.meta.url.endsWith("/host.ts")) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export const HOST_CONFIG_ENV = "CODE_EMBED_HOST_CONFIG";

export function hostConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbedHostConfig {
  const raw = env[HOST_CONFIG_ENV];
  if (!raw) throw new Error(`${HOST_CONFIG_ENV} is not set`);
  return JSON.parse(raw) as EmbedHostConfig;
}

if (isEntry()) {
  Promise.resolve()
    .then(() => runEmbedHost(hostConfigFromEnv()))
    .then(
    () => process.exit(0),
    (err: unknown) => {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
