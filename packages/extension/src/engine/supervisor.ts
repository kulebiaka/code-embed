import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import {
  EngineRpcError,
  ErrorCodes,
  PROTOCOL_VERSION,
  createEngineProxy,
  type Disposable,
  type EngineApi,
  type IndexStatus,
} from "@code-embed/protocol";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import * as vscode from "vscode";
import { registerEditorEvents } from "../events";
import { SECTION, readEngineSettings, workspaceRoot } from "../settings";
import { engineEntry, engineLaunch } from "./paths";
import type { ClientState, EngineClient, EngineSupervisor } from "./types";

export const BACKOFF_MS = [1000, 2000, 4000, 8000];
export const CRASH_WINDOW_MS = 5 * 60_000;
export const MAX_CRASHES = 4;
const STATUS_POLL_MS = 3000;
const SOCKET_PROBE_MS = 1000;
const PRINT_SOCKET_TIMEOUT_MS = 15_000;

export function planRestart(crashes: number[], now: number): { crashes: number[]; delayMs: number | undefined } {
  const recent = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
  if (recent.length >= MAX_CRASHES) return { crashes: recent, delayMs: undefined };
  return { crashes: recent, delayMs: BACKOFF_MS[recent.length - 1] };
}

class Emitter<T> {
  private readonly listeners = new Set<(v: T) => void>();
  on(cb: (v: T) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => void this.listeners.delete(cb) };
  }
  fire(v: T): void {
    for (const l of [...this.listeners]) l(v);
  }
}

interface Session {
  conn: MessageConnection;
  api: EngineApi;
  child?: ChildProcess;
  socket?: net.Socket;
  subs: Disposable[];
  closed: boolean;
}

function probeSocket(path: string): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, SOCKET_PROBE_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(undefined);
    });
  });
}

export function createEngineSupervisor(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): EngineSupervisor {
  const stateEmitter = new Emitter<ClientState>();
  const statusEmitter = new Emitter<IndexStatus>();
  const progressEmitter = new Emitter<Parameters<Parameters<EngineApi["onProgress"]>[0]>[0]>();
  const errorEmitter = new Emitter<Parameters<Parameters<EngineApi["onIndexError"]>[0]>[0]>();
  const logEmitter = new Emitter<Parameters<Parameters<EngineApi["onLog"]>[0]>[0]>();

  let state: ClientState = "stopped";
  let lastStatus: IndexStatus | undefined;
  let session: Session | undefined;
  let crashes: number[] = [];
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let events: Disposable | undefined;
  let generation = 0;
  let disposed = false;
  let waiters: { resolve: (api: EngineApi) => void; reject: (e: Error) => void }[] = [];

  const setState = (s: ClientState) => {
    if (state === s) return;
    state = s;
    stateEmitter.fire(s);
    if (s === "ready") {
      const pending = waiters;
      waiters = [];
      pending.forEach((w) => w.resolve(session!.api));
    } else if (s === "failed" || s === "stopped") {
      const pending = waiters;
      waiters = [];
      pending.forEach((w) => w.reject(new Error(`Code Embed engine is ${s}`)));
    }
  };

  const setStatus = (s: IndexStatus) => {
    lastStatus = s;
    statusEmitter.fire(s);
  };

  const apiFor = (): Promise<EngineApi> => {
    if (state === "ready" && session) return Promise.resolve(session.api);
    if (state === "starting" || state === "restarting") {
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }
    return Promise.reject(new Error(`Code Embed engine is ${state}`));
  };
  const call = <T>(fn: (api: EngineApi) => Promise<T>): Promise<T> => apiFor().then(fn);
  const notify = (fn: (api: EngineApi) => void) => {
    if (state === "ready" && session) fn(session.api);
  };

  const client: EngineClient = {
    get state() {
      return state;
    },
    get lastStatus() {
      return lastStatus;
    },
    onDidChangeState: (cb) => stateEmitter.on(cb),
    onStatus: (cb) => statusEmitter.on(cb),
    initialize: (p) => call((a) => a.initialize(p)),
    search: (p, signal) => call((a) => a.search(p, signal)),
    findSimilar: (p, signal) => call((a) => a.findSimilar(p, signal)),
    status: () => call((a) => a.status()).then((s) => (setStatus(s), s)),
    rebuild: (p) => call((a) => a.rebuild(p)),
    pause: () => call((a) => a.pause()),
    resume: () => call((a) => a.resume()),
    updateSettings: (p) => call((a) => a.updateSettings(p)),
    testProvider: (p) => call((a) => a.testProvider(p)),
    listProviders: () => call((a) => a.listProviders()),
    listModels: () => call((a) => a.listModels()),
    grantConsent: (p) => call((a) => a.grantConsent(p)),
    shutdown: () => call((a) => a.shutdown()),
    filesChanged: (p) => notify((a) => a.filesChanged(p)),
    filesOpened: (p) => notify((a) => a.filesOpened(p)),
    setActive: (p) => notify((a) => a.setActive(p)),
    onProgress: (cb) => progressEmitter.on(cb),
    onIndexError: (cb) => errorEmitter.on(cb),
    onLog: (cb) => logEmitter.on(cb),
  };

  const log = (line: string) => output.appendLine(line);

  const printSocket = (root: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      const l = engineLaunch(ctx, ["daemon", "--print-socket", "--root", root]);
      execFile(
        l.command,
        l.args,
        { env: { ...process.env, ...l.env }, timeout: PRINT_SOCKET_TIMEOUT_MS },
        (err, stdout) => {
          const line = err ? undefined : String(stdout).trim().split("\n").pop();
          resolve(line || undefined);
        },
      );
    });

  const collectApiKeys = async (settings: ReturnType<typeof readEngineSettings>): Promise<Record<string, string>> => {
    const names = new Set(Object.keys(settings.providers ?? {}));
    if (settings.embedding?.provider) names.add(settings.embedding.provider);
    const keys: Record<string, string> = {};
    for (const name of names) {
      const key = await ctx.secrets.get(`codeEmbed.apiKey.${name}`);
      if (key) keys[name] = key;
    }
    return keys;
  };

  const teardown = (s: Session) => {
    s.closed = true;
    s.subs.forEach((d) => d.dispose());
    s.conn.dispose();
    s.socket?.destroy();
    if (s.child && s.child.exitCode === null) s.child.kill();
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const onSessionLost = (s: Session, gen: number, why: string) => {
    if (s.closed || gen !== generation || disposed) return;
    log(`Engine connection lost: ${why}`);
    teardown(s);
    if (session === s) session = undefined;
    stopPolling();
    events?.dispose();
    events = undefined;
    const plan = planRestart(crashes, Date.now());
    crashes = plan.crashes;
    if (plan.delayMs === undefined) {
      setState("failed");
      void vscode.window
        .showErrorMessage(`Code Embed engine crashed ${MAX_CRASHES} times in 5 minutes.`, "Show Log")
        .then((choice) => {
          if (choice === "Show Log") output.show(true);
        });
      return;
    }
    setState("restarting");
    log(`Restarting engine in ${plan.delayMs / 1000}s`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void connect();
    }, plan.delayMs);
  };

  const fail = (message: string) => {
    log(message);
    setState("failed");
    void vscode.window.showErrorMessage(message, "Show Log").then((choice) => {
      if (choice === "Show Log") output.show(true);
    });
  };

  const connect = async (): Promise<void> => {
    const gen = ++generation;
    const root = workspaceRoot();
    if (!root) {
      setState("stopped");
      return;
    }
    if (state !== "restarting") setState("starting");

    const s: Session = { conn: undefined as never, api: undefined as never, subs: [], closed: false };
    try {
      const socketPath = await printSocket(root);
      const socket = socketPath ? await probeSocket(socketPath) : undefined;
      if (gen !== generation) {
        socket?.destroy();
        return;
      }
      let input: NodeJS.ReadableStream;
      let outputStream: NodeJS.WritableStream;
      if (socket) {
        log(`Connected to daemon socket ${socketPath}`);
        s.socket = socket;
        input = socket;
        outputStream = socket;
        socket.once("close", () => onSessionLost(s, gen, "daemon socket closed"));
      } else {
        const l = engineLaunch(ctx, ["serve"]);
        log(`Starting engine: ${engineEntry(ctx)} serve`);
        const child = spawn(l.command, l.args, {
          cwd: root,
          env: { ...process.env, ...l.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        s.child = child;
        child.stderr.on("data", (d: Buffer) => output.append(d.toString()));
        child.once("error", (err) => onSessionLost(s, gen, `spawn error: ${err.message}`));
        child.once("exit", (code, sig) => onSessionLost(s, gen, `engine exited (${sig ?? code})`));
        input = child.stdout;
        outputStream = child.stdin;
      }

      s.conn = createMessageConnection(
        new StreamMessageReader(input as NodeJS.ReadableStream & { on: never }),
        new StreamMessageWriter(outputStream as NodeJS.WritableStream & { on: never }),
      );
      s.api = createEngineProxy(s.conn);
      s.subs.push(
        s.api.onLog((p) => {
          log(`[${p.level}] ${p.message}`);
          logEmitter.fire(p);
        }),
        s.api.onProgress((p) => {
          if (lastStatus) setStatus({ ...lastStatus, phase: p.phase, embedded: p.embedded });
          progressEmitter.fire(p);
        }),
        s.api.onIndexError((p) => {
          log(`[index error] ${p.path ? `${p.path}: ` : ""}${p.message}`);
          errorEmitter.fire(p);
        }),
      );
      s.conn.onClose(() => onSessionLost(s, gen, "connection closed"));
      s.conn.listen();
      session = s;

      const settings = readEngineSettings();
      const init = await s.api.initialize({
        root,
        clientName: "vscode",
        protocolVersion: PROTOCOL_VERSION,
        active: vscode.window.state.focused,
        settings,
        apiKeys: await collectApiKeys(settings),
      });
      if (gen !== generation || s.closed) return;
      setStatus(init.index);
      setState("ready");
      events = registerEditorEvents(client);
      pollTimer = setInterval(() => {
        if (lastStatus && lastStatus.phase !== "idle") void s.api.status().then(setStatus, () => undefined);
      }, STATUS_POLL_MS);
    } catch (err) {
      if (gen !== generation || disposed) return;
      if (err instanceof EngineRpcError && err.code === ErrorCodes.ProtocolMismatch) {
        if (s.conn) teardown(s);
        session = undefined;
        fail("Code Embed: protocol version mismatch, update the extension/CLI.");
        return;
      }
      onSessionLost(s, gen, err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (): Promise<void> => {
    generation++;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
    stopPolling();
    events?.dispose();
    events = undefined;
    const s = session;
    session = undefined;
    if (s && !s.closed) {
      if (s.child) await Promise.race([s.api.shutdown().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
      teardown(s);
    }
  };

  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    const relevant = [SECTION, "files.exclude", "search.exclude", "http.proxy"].some((k) => e.affectsConfiguration(k));
    if (!relevant || state !== "ready") return;
    client.updateSettings(readEngineSettings()).catch((err: unknown) => {
      log(`settings.update failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  return {
    client,
    start: async () => {
      if (disposed) return;
      crashes = [];
      await connect();
    },
    restart: async () => {
      await stop();
      crashes = [];
      setState("restarting");
      await connect();
    },
    showLog: () => output.show(true),
    dispose: () => {
      disposed = true;
      configSub.dispose();
      void stop().then(() => setState("stopped"));
    },
  };
}
