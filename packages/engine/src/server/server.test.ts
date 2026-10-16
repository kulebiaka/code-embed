import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EngineRpcError,
  ErrorCodes,
  PROTOCOL_VERSION,
  createEngineProxy,
  type LogParams,
} from "@code-embed/protocol";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { socketPath } from "../core/paths";
import type { LocalEngine, LocalEngineOptions } from "../engine/types";
import { LockedError } from "../errors";
import { initHashing } from "../util/hash";

vi.mock("../engine/service", async (orig) => ({
  ...(await orig<typeof import("../engine/service")>()),
  createLocalEngine: vi.fn(),
}));

import { createLocalEngine } from "../engine/service";
import { connectDaemon, openEngine } from "./client";
import { runDaemon, stopDaemon } from "./daemon";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

let tmp: string;
let root: string;
const saved = { cache: process.env.CODE_EMBED_CACHE_DIR, tmpdir: process.env.TMPDIR };

function fakeEngine(over: Record<string, unknown> = {}) {
  const status = { root, readOnly: false, daemon: true, phase: "idle" };
  return {
    root,
    initialize: vi.fn(async (p: { protocolVersion: number }) => ({
      serverVersion: "t",
      protocolVersion: p.protocolVersion,
      capabilities: { search: true, findSimilar: true, watcher: true, readOnly: false },
      index: status,
    })),
    search: vi.fn(async (p: { query: string }) => ({ results: [], partial: false, tookMs: 1, total: p.query.length })),
    status: vi.fn(async () => status),
    setActive: vi.fn(),
    onProgress: vi.fn(() => ({ dispose() {} })),
    onIndexError: vi.fn(() => ({ dispose() {} })),
    onLog: vi.fn(() => ({ dispose() {} })),
    close: vi.fn(async () => {}),
    ...over,
  } as unknown as LocalEngine & {
    initialize: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

beforeEach(async () => {
  await initHashing();
  tmp = mkdtempSync(join(tmpdir(), "ce-srv-"));
  root = join(tmp, "repo");
  mkdirSync(root);
  process.env.CODE_EMBED_CACHE_DIR = join(tmp, "cache");
  process.env.TMPDIR = mkdtempSync("/tmp/ce-");
  vi.mocked(createLocalEngine).mockReset();
});

afterEach(() => {
  process.env.CODE_EMBED_CACHE_DIR = saved.cache;
  rmSync(process.env.TMPDIR!, { recursive: true, force: true });
  process.env.TMPDIR = saved.tmpdir;
  if (saved.cache === undefined) delete process.env.CODE_EMBED_CACHE_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const init = (clientName: string, protocolVersion = PROTOCOL_VERSION) => ({
  root,
  clientName,
  protocolVersion,
});

async function startDaemon(engine: LocalEngine) {
  const createEngine = vi.fn(async () => engine);
  const done = runDaemon({ root, createEngine });
  const sock = socketPath(root);
  await vi.waitFor(() => expect(existsSync(sock)).toBe(true));
  return { done, createEngine };
}

describeUnix("daemon over a unix socket", () => {
  it("serves two clients with one engine and stops cleanly", async () => {
    const engine = fakeEngine();
    const { done, createEngine } = await startDaemon(engine);
    expect(createEngine).toHaveBeenCalledTimes(1);

    const [a, b] = await Promise.all([connectDaemon(root, "a"), connectDaemon(root, "b")]);
    expect(a && b).toBeTruthy();
    const [ra, rb] = await Promise.all([a!.initialize(init("a")), b!.initialize(init("b"))]);
    expect(ra.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(rb.capabilities.watcher).toBe(true);
    expect(engine.initialize).toHaveBeenCalledTimes(1);

    const [sa, sb] = await Promise.all([a!.search({ query: "aa" }), b!.search({ query: "bbbb" })]);
    expect(sa.total).toBe(2);
    expect(sb.total).toBe(4);

    expect(await stopDaemon(root)).toBe(true);
    await done;
    expect(engine.close).toHaveBeenCalled();
    expect(existsSync(socketPath(root))).toBe(false);
    a!.close();
    b!.close();
    expect(await connectDaemon(root, "c")).toBeNull();
  });

  it("goes to the background only when every client is in the background", async () => {
    const engine = fakeEngine();
    const { done } = await startDaemon(engine);
    const last = () => vi.mocked(engine.setActive).mock.calls.at(-1)?.[0];
    const [a, b] = await Promise.all([connectDaemon(root, "a"), connectDaemon(root, "b")]);
    await a!.initialize({ ...init("a"), active: false });
    await b!.initialize(init("b"));
    expect(last()).toEqual({ active: true });
    b!.setActive({ active: false });
    await vi.waitFor(() => expect(last()).toEqual({ active: false }));
    a!.setActive({ active: true });
    await vi.waitFor(() => expect(last()).toEqual({ active: true }));
    a!.close();
    await vi.waitFor(() => expect(last()).toEqual({ active: false }));
    expect(await stopDaemon(root)).toBe(true);
    await done;
    b!.close();
  });

  it("accepts a symlinked root and rejects a foreign one", async () => {
    const link = join(tmp, "link");
    symlinkSync(root, link);
    const other = join(tmp, "other");
    mkdirSync(other);
    const { done } = await startDaemon(fakeEngine());
    const c = (await connectDaemon(root, "a"))!;
    expect((await c.initialize({ ...init("a"), root: link })).protocolVersion).toBe(PROTOCOL_VERSION);
    const err = await c.initialize({ ...init("a"), root: other }).catch((e: unknown) => e);
    expect((err as EngineRpcError).code).toBe(-32600);
    c.close();
    await stopDaemon(root);
    await done;
  });

  it("refuses to start a second daemon", async () => {
    const { done } = await startDaemon(fakeEngine());
    await expect(runDaemon({ root, createEngine: async () => fakeEngine() })).rejects.toBeInstanceOf(LockedError);
    await stopDaemon(root);
    await done;
  });

  it("rejects a held lock and removes a stale socket", async () => {
    const lockDir = join(root, ".code-embed");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "lock"), String(process.ppid));
    await expect(runDaemon({ root, createEngine: async () => fakeEngine() })).rejects.toBeInstanceOf(LockedError);
    rmSync(join(lockDir, "lock"));

    mkdirSync(join(process.env.TMPDIR!, "code-embed"), { recursive: true });
    writeFileSync(socketPath(root), "stale");
    expect(await connectDaemon(root, "x")).toBeNull();
    const engine = fakeEngine();
    const done = runDaemon({ root, createEngine: async () => engine });
    await vi.waitFor(async () => expect(await connectDaemon(root, "x")).not.toBeNull());
    await stopDaemon(root);
    await done;
  });

  it("returns null quickly when there is no daemon", async () => {
    const t = Date.now();
    expect(await connectDaemon(root, "x")).toBeNull();
    expect(Date.now() - t).toBeLessThan(400);
  });

  it("rejects a mismatching protocol version over the socket", async () => {
    const { done } = await startDaemon(fakeEngine());
    const c = (await connectDaemon(root, "old"))!;
    const err = await c.initialize(init("old", PROTOCOL_VERSION + 1)).catch((e: unknown) => e);
    expect((err as EngineRpcError).code).toBe(ErrorCodes.ProtocolMismatch);
    c.close();
    await stopDaemon(root);
    await done;
  });

  it("stops a non-socket lock holder by PID", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const lockDir = join(root, ".code-embed");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "lock"), String(child.pid));
    expect(await stopDaemon(root)).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });
});

describeUnix("openEngine", () => {
  const opts = (): LocalEngineOptions => ({ root, clientName: "cli" });

  it("uses the daemon when alive", async () => {
    const { done } = await startDaemon(fakeEngine());
    const opened = await openEngine(opts());
    expect(opened.viaDaemon).toBe(true);
    expect(opened.local).toBeNull();
    expect(createLocalEngine).not.toHaveBeenCalled();
    await opened.close();
    await stopDaemon(root);
    await done;
  });

  it("falls back to a local engine", async () => {
    const local = fakeEngine();
    vi.mocked(createLocalEngine).mockResolvedValue(local);
    const opened = await openEngine(opts());
    expect(opened.viaDaemon).toBe(false);
    expect(opened.local).toBe(local);
    expect(vi.mocked(createLocalEngine).mock.calls[0]![0].readonly).toBeFalsy();
    await opened.close();
    expect(local.close).toHaveBeenCalled();
  });

  it("opens read-only when another live process holds the lock", async () => {
    vi.mocked(createLocalEngine).mockResolvedValue(fakeEngine());
    const lockDir = join(root, ".code-embed");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "lock"), String(process.ppid));
    await openEngine({ ...opts(), preferDaemon: false });
    expect(vi.mocked(createLocalEngine).mock.calls[0]![0].readonly).toBe(true);
    expect(vi.mocked(createLocalEngine).mock.calls[0]![0]).not.toHaveProperty("preferDaemon");
  });
});

describe("serveStdio", () => {
  it("keeps stdout protocol-only and mirrors logs as notifications", async () => {
    const fixture = fileURLToPath(new URL("./serve-fixture.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const raw: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => raw.push(d));

    const conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const proxy = createEngineProxy(conn);
    const logs: LogParams[] = [];
    proxy.onLog((l) => logs.push(l));
    conn.listen();

    const res = await proxy.initialize({ root: "/fixture", clientName: "t", protocolVersion: PROTOCOL_VERSION });
    expect(res.serverVersion).toBe("fixture");
    await proxy.search({ query: "q" });
    await vi.waitFor(() => expect(logs.some((l) => l.message === "hello from engine")).toBe(true));
    await proxy.shutdown();
    await new Promise((r) => child.once("exit", r));

    const out = Buffer.concat(raw).toString();
    const frames = out.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(() => JSON.parse(f)).not.toThrow();
    expect(out).not.toContain("stray stdout noise");
    expect(stderr).toContain("stray stdout noise");
    expect(stderr).toContain("hello from engine");
    conn.dispose();
  }, 30000);
});
