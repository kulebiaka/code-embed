import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  EngineRpcError,
  PROTOCOL_VERSION,
  registerEngineHandlers,
  type EngineApi,
  type InitializeResult,
} from "@code-embed/protocol";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node";
import { ensureIndexDir } from "../core/index-dir";
import { acquireLock, isProcessAlive, readLockPid } from "../core/lock";
import { cacheDir, canonicalRoot, rootHash, socketPath } from "../core/paths";
import { SERVER_VERSION } from "../engine/service";
import type { LocalEngine } from "../engine/types";
import { LockedError } from "../errors";
import { initHashing } from "../util/hash";
import { log } from "../util/log";
import { probeSocket } from "./client";
import { indexDirFor } from "./index-dir";

export interface DaemonOptions {
  root: string;
  createEngine: (root: string) => Promise<LocalEngine>;
  detach?: boolean;
}

const STOP_WAIT_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}

async function isDaemonAlive(root: string): Promise<boolean> {
  const probe = await probeSocket(socketPath(root), 200);
  probe?.destroy();
  return probe !== null;
}

async function spawnDetached(root: string): Promise<void> {
  const logDir = join(cacheDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `daemon-${rootHash(root)}.log`);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "daemon", "--root", root], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    const up = await waitFor(() => isDaemonAlive(root), 15000);
    if (!up) throw new Error(`daemon did not start; see ${logFile}`);
    log.info(`daemon started (pid ${child.pid}), log: ${logFile}`);
  } finally {
    closeSync(fd);
  }
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  await initHashing();
  const { root } = opts;
  const sock = socketPath(root);

  if (await isDaemonAlive(root)) {
    log.error(`daemon is already running for ${root}`);
    throw new LockedError(readLockPid(indexDirFor(root)) ?? 0);
  }
  if (opts.detach) return spawnDetached(root);

  const indexDir = indexDirFor(root);
  ensureIndexDir(indexDir);
  const lock = acquireLock(indexDir);
  if (!lock) {
    const pid = readLockPid(indexDir) ?? 0;
    log.error(`index is locked by another process (pid ${pid}); not starting the daemon`);
    throw new LockedError(pid);
  }

  let engine: LocalEngine;
  try {
    engine = await opts.createEngine(root);
  } catch (err) {
    lock.release();
    throw err;
  }

  const isUnix = process.platform !== "win32";
  if (isUnix) {
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
    rmSync(sock, { force: true });
  }

  const clients = new Set<Socket>();
  let initialized = false;
  let stop: () => Promise<void> = async () => {};

  const facadeFor = (): EngineApi => ({
    initialize: async (p) => {
      if (canonicalRoot(p.root) !== canonicalRoot(root)) {
        throw new EngineRpcError(-32600, `daemon serves ${root}, not ${p.root}`);
      }
      if (!initialized) {
        initialized = true;
        return engine.initialize(p);
      }
      const index = await engine.status();
      return {
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { search: true, findSimilar: true, watcher: true, readOnly: index.readOnly },
        index,
      } satisfies InitializeResult;
    },
    search: (p, s) => engine.search(p, s),
    findSimilar: (p, s) => engine.findSimilar(p, s),
    status: () => engine.status(),
    rebuild: (p) => engine.rebuild(p),
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    updateSettings: (p) => engine.updateSettings(p),
    testProvider: (p) => engine.testProvider(p),
    listProviders: () => engine.listProviders(),
    listModels: () => engine.listModels(),
    grantConsent: (p) => engine.grantConsent(p),
    shutdown: async () => {
      setTimeout(() => void stop(), 20);
    },
    filesChanged: (p) => engine.filesChanged(p),
    filesOpened: (p) => engine.filesOpened(p),
    onProgress: (cb) => engine.onProgress(cb),
    onIndexError: (cb) => engine.onIndexError(cb),
    onLog: (cb) => engine.onLog(cb),
  });

  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    const handlers = registerEngineHandlers(conn, facadeFor());
    const cleanup = () => {
      clients.delete(socket);
      handlers.dispose();
      conn.dispose();
    };
    socket.once("close", cleanup);
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
    await engine.close().catch(() => {});
    lock.release();
    throw err;
  }
  if (isUnix) chmodSync(sock, 0o600);
  log.info(`daemon listening on ${sock} (pid ${process.pid})`);

  return new Promise<void>((resolve) => {
    let stopping: Promise<void> | null = null;
    const onSignal = () => void stop();
    stop = () => {
      stopping ??= (async () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        const closed = new Promise<void>((r) => server.close(() => r()));
        for (const c of clients) c.destroy();
        await closed;
        try {
          await engine.close();
        } catch (err) {
          log.error(`engine close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
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

export async function stopDaemon(root: string): Promise<boolean> {
  await initHashing();
  const socket = await probeSocket(socketPath(root), 200);
  if (socket) {
    const closed = new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), STOP_WAIT_MS).unref();
    });
    const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    socket.on("error", () => {});
    conn.listen();
    try {
      await conn.sendRequest("shutdown");
    } catch {
      conn.dispose();
      socket.destroy();
      return false;
    }
    const ok = await closed;
    conn.dispose();
    socket.destroy();
    return ok;
  }

  const pid = readLockPid(indexDirFor(root));
  if (pid === null || pid === process.pid || !isProcessAlive(pid)) return false;
  process.kill(pid, "SIGTERM");
  return waitFor(() => !isProcessAlive(pid), STOP_WAIT_MS);
}
