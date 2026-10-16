import {
  EngineRpcError,
  registerEngineHandlers,
  type Disposable,
  type EngineApi,
  type IndexErrorParams,
  type IndexProgress,
  type InitializeParams,
  type LogParams,
} from "@code-embed/protocol";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node";
import type { LocalEngine } from "../engine/types";
import { log, setLogSink } from "../util/log";

const INVALID_REQUEST = -32600;

function emitter<T>() {
  const listeners = new Set<(p: T) => void>();
  return {
    on(cb: (p: T) => void): Disposable {
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    },
    emit(p: T) {
      for (const l of [...listeners]) l(p);
    },
  };
}

export function serveStdio(opts: { createEngine: (init: InitializeParams) => Promise<LocalEngine> }): Promise<void> {
  // stdout carries only protocol frames: stray console.log output is diverted to stderr
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

  const input = process.stdin;
  const conn = createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(process.stdout));

  let engine: LocalEngine | null = null;
  let engineSubs: Disposable[] = [];
  const progress = emitter<IndexProgress>();
  const indexError = emitter<IndexErrorParams>();
  const logs = emitter<LogParams>();
  let finish: () => Promise<void> = async () => {};

  const need = (): LocalEngine => {
    if (!engine) throw new EngineRpcError(INVALID_REQUEST, "engine is not initialized: send `initialize` first");
    return engine;
  };

  setLogSink((level, message) => logs.emit({ level, message }));

  const api: EngineApi = {
    async initialize(p) {
      if (engine) throw new EngineRpcError(INVALID_REQUEST, "already initialized");
      engine = await opts.createEngine(p);
      engineSubs = [
        engine.onProgress((e) => progress.emit(e)),
        engine.onIndexError((e) => indexError.emit(e)),
        engine.onLog((e) => logs.emit(e)),
      ];
      return engine.initialize(p);
    },
    search: (p, s) => need().search(p, s),
    findSimilar: (p, s) => need().findSimilar(p, s),
    status: () => need().status(),
    rebuild: (p) => need().rebuild(p),
    pause: () => need().pause(),
    resume: () => need().resume(),
    updateSettings: (p) => need().updateSettings(p),
    testProvider: (p) => need().testProvider(p),
    listProviders: () => need().listProviders(),
    listModels: () => need().listModels(),
    grantConsent: (p) => need().grantConsent(p),
    shutdown: async () => {
      setTimeout(() => void finish(), 20);
    },
    filesChanged: (p) => engine?.filesChanged(p),
    filesOpened: (p) => engine?.filesOpened(p),
    setActive: (p) => engine?.setActive(p),
    onProgress: progress.on,
    onIndexError: indexError.on,
    onLog: logs.on,
  };

  const handlers = registerEngineHandlers(conn, api);

  return new Promise<void>((resolve) => {
    let done = false;
    finish = async () => {
      if (done) return;
      done = true;
      setLogSink(null);
      handlers.dispose();
      engineSubs.forEach((s) => s.dispose());
      conn.dispose();
      input.pause();
      try {
        await engine?.close();
      } catch (err) {
        log.error(`engine close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      resolve();
    };
    conn.onClose(() => void finish());
    input.once("end", () => void finish());
    conn.listen();
  });
}
