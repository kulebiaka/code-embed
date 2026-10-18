import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CancellationTokenSource,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import { isProcessAlive, readLockPid } from "../core/lock";
import { cacheDir, embedHostSocketPath } from "../core/paths";
import { ProviderUnavailableError } from "../errors";
import { initHashing } from "../util/hash";
import { log } from "../util/log";
import { probeSocket } from "../util/socket";
import {
  HOST_CONFIG_ENV,
  HOST_PROTOCOL_VERSION,
  decodeVector,
  hostKey,
  hostLockName,
  type EmbedErrorData,
  type EmbedHostConfig,
  type EmbedParams,
  type EmbedPrio,
  type EmbedResult,
  type HelloParams,
  type HelloResult,
} from "./host";
import { createLocalEmbedder, type LocalEmbedderOptions } from "./local";
import type { Embedder, ModelEntry } from "./types";
import { createWorkerEmbedder, splitDocuments, toError, tsxExecArgv } from "./worker";

export interface HostEmbedderOptions {
  project?: string;
  env?: NodeJS.ProcessEnv;
  worker?: EmbedHostConfig["worker"];
  idleUnloadMs?: number;
  idleExitMs?: number;
  startTimeoutMs?: number;
}

const START_TIMEOUT_MS = 15_000;
const PROBE_MS = 200;
let nextClient = 0;

export function sharedHostEnabled(): boolean {
  return process.env.CODE_EMBED_SHARED_HOST === "1";
}

function hostEntry(): { modulePath: string; args: string[]; execArgv: string[] } {
  if (import.meta.url.endsWith(".js")) {
    return { modulePath: fileURLToPath(import.meta.url), args: ["__embed-host"], execArgv: [] };
  }
  return { modulePath: fileURLToPath(new URL("./host.ts", import.meta.url)), args: [], execArgv: tsxExecArgv() };
}

function spawnHost(key: string, cfg: EmbedHostConfig, env: NodeJS.ProcessEnv): string {
  const logDir = join(cacheDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `embed-host-${key}.log`);
  const fd = openSync(logFile, "a");
  try {
    const e = hostEntry();
    const child = spawn(process.execPath, [...e.execArgv, e.modulePath, ...e.args], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: cacheDir(),
      env: { ...env, [HOST_CONFIG_ENV]: JSON.stringify(cfg) },
      windowsHide: true,
    });
    child.on("error", (err) => log.warn(`embedding host failed to start: ${err.message}`));
    child.unref();
  } finally {
    closeSync(fd);
  }
  return logFile;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Link {
  conn: MessageConnection;
  socket: Socket;
  closed: boolean;
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Inference in the machine-wide host process; without a host it falls back to a private worker process.
export function createHostEmbedder(entry: ModelEntry, opts: LocalEmbedderOptions, o: HostEmbedderOptions = {}): Embedder {
  const info = createLocalEmbedder(entry, opts).info;
  const cfg: EmbedHostConfig = {
    model: entry.id,
    opts,
    worker: o.worker,
    idleUnloadMs: o.idleUnloadMs,
    idleExitMs: o.idleExitMs,
  };
  const clientId = `${process.pid}-${++nextClient}`;
  let link: Link | undefined;
  let connecting: Promise<void> | undefined;
  let fallback: Embedder | undefined;
  let active = true;
  let disposed = false;

  const useFallback = (reason: string) => {
    log.warn(`${reason}; using a private inference process`);
    fallback = createWorkerEmbedder(entry, opts, {
      modulePath: o.worker?.modulePath,
      execArgv: o.worker?.execArgv,
      env: o.env,
      idleUnloadMs: o.idleUnloadMs,
    });
  };

  const connect = async (): Promise<Link | string> => {
    await initHashing();
    const key = hostKey(cfg);
    const path = embedHostSocketPath(key);
    let logFile = join(cacheDir(), "logs", `embed-host-${key}.log`);
    const deadline = Date.now() + (o.startTimeoutMs ?? START_TIMEOUT_MS);
    let spawned = false;
    let socket: Socket | null;
    // the lock is checked on every round: a host that is starting, or has just died, holds it for a moment
    for (;;) {
      socket = await probeSocket(path, PROBE_MS);
      if (socket || Date.now() >= deadline) break;
      if (!spawned) {
        const pid = readLockPid(cacheDir(), hostLockName(key));
        if (pid === null || !isProcessAlive(pid)) {
          logFile = spawnHost(key, cfg, o.env ?? process.env);
          spawned = true;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!socket) return `embedding host did not start; see ${logFile}`;
    socket.on("error", () => {});
    const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    const l: Link = { conn, socket, closed: false };
    socket.once("close", () => {
      l.closed = true;
      if (link === l) link = undefined;
      conn.dispose();
    });
    conn.listen();
    try {
      const hello: HelloParams = {
        protocolVersion: HOST_PROTOCOL_VERSION,
        modelId: entry.id,
        threads: opts.threads,
        clientId,
        project: o.project,
        active,
      };
      const r = await conn.sendRequest<HelloResult>("hello", hello);
      if (r.dims !== info.dims) throw new Error(`host reports ${r.dims} dims, expected ${info.dims}`);
    } catch (err) {
      conn.dispose();
      socket.destroy();
      return `embedding host rejected the connection: ${msg(err)}`;
    }
    return l;
  };

  const backend = async (): Promise<Link | Embedder> => {
    if (disposed) throw new Error("embedder disposed");
    if (fallback) return fallback;
    if (link) return link;
    connecting ??= connect()
      .catch((err: unknown) => `embedding host is unavailable: ${msg(err)}`)
      .then((r) => {
        if (typeof r === "string") useFallback(r);
        else if (disposed) r.socket.destroy();
        else link = r;
      })
      .finally(() => {
        connecting = undefined;
      });
    await connecting;
    if (disposed) throw new Error("embedder disposed");
    return fallback ?? link ?? Promise.reject(new ProviderUnavailableError("embedding host connection lost"));
  };

  const remote = async (l: Link, params: EmbedParams, signal?: AbortSignal): Promise<Float32Array[]> => {
    const cts = new CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await abortable(l.conn.sendRequest<EmbedResult>("embed", params, cts.token), signal);
      return r.vectors.map(decodeVector);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      const data = err instanceof ResponseError ? (err.data as EmbedErrorData | undefined) : undefined;
      if (data?.name) throw toError({ name: data.name, message: (err as Error).message, retryAfterMs: data.retryAfterMs });
      throw new ProviderUnavailableError(`embedding host connection lost: ${msg(err)}`);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      cts.dispose();
    }
  };

  const embed = async (kind: "query" | "document", texts: string[], signal?: AbortSignal) => {
    if (texts.length === 0) return [];
    const b = await abortable(backend(), signal);
    if (!("conn" in b)) return kind === "query" ? b.embedQueries(texts, signal) : b.embedDocuments(texts, signal);
    const prio: EmbedPrio = kind === "query" ? "query" : splitDocuments(texts).length === 1 ? "interactive" : "batch";
    return remote(b, { kind, texts, prio }, signal);
  };

  return {
    info,
    get shared() {
      return !fallback;
    },
    async init(signal) {
      const b = await abortable(backend(), signal);
      if (!("conn" in b)) await b.init(signal);
    },
    embedQueries: (texts, signal) => embed("query", texts, signal),
    embedDocuments: (texts, signal) => embed("document", texts, signal),
    countTokens: (text) => Math.ceil(text.length / 4),
    setActive(a) {
      active = a;
      if (link) void link.conn.sendNotification("activity", { active: a }).catch(() => {});
    },
    async unload() {
      await fallback?.unload?.();
    },
    async dispose() {
      disposed = true;
      const l = link;
      link = undefined;
      l?.conn.dispose();
      l?.socket.destroy();
      await fallback?.dispose();
    },
  };
}
