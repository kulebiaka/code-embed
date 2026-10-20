import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config/types";
import { embedHostSocketPath } from "../../src/core/paths";
import { getModel } from "../../src/embed/catalog";
import { HOST_PROTOCOL_VERSION, hostKey, hostLockName, type EmbedHostConfig, type HelloResult } from "../../src/embed/host";
import { initHashing } from "../../src/util/hash";
import { CLI, ensureBuilt, waitUntil } from "./helpers";

let base: string;
let cache: string;
let cfg: EmbedHostConfig;
let key: string;
const children: ChildProcess[] = [];

function hostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CODE_EMBED_")) env[k] = v;
  return { ...env, CODE_EMBED_CACHE_DIR: cache, NODE_NO_WARNINGS: "1" };
}

function startHost(withConfig = true): ChildProcess {
  const c = spawn(process.execPath, [CLI, "__embed-host"], {
    env: { ...hostEnv(), ...(withConfig ? { CODE_EMBED_HOST_CONFIG: JSON.stringify(cfg) } : {}) },
    stdio: "ignore",
  });
  children.push(c);
  return c;
}

const exited = (c: ChildProcess) =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve(c.exitCode)
    : new Promise<number | null>((r) => c.once("exit", (code) => r(code)));

beforeAll(async () => {
  ensureBuilt();
  await initHashing();
});

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ce-e2e-host-")));
  cache = join(base, "cache");
  cfg = { modelsDir: join(base, "models"), idleExitMs: 20000 };
  key = hostKey(cfg);
});

afterEach(async () => {
  for (const c of children.splice(0)) {
    c.kill("SIGKILL");
    await exited(c);
  }
  rmSync(embedHostSocketPath(key), { force: true });
  rmSync(base, { recursive: true, force: true });
});

describe("__embed-host (bundle)", () => {
  it("is hidden from --help", () => {
    const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 15000 });
    expect(r.stdout + r.stderr).not.toContain("__embed-host");
  });

  it("exits with an error without CODE_EMBED_HOST_CONFIG", async () => {
    const c = startHost(false);
    expect(await exited(c)).not.toBe(0);
    expect(existsSync(embedHostSocketPath(key))).toBe(false);
  });

  it("listens, answers hello without loading the model, and cleans up on SIGTERM", async () => {
    const sock = embedHostSocketPath(key);
    const lock = join(cache, hostLockName(key));
    const first = startHost();
    expect(await waitUntil(async () => existsSync(sock), 15000)).toBe(true);
    if (process.platform !== "win32") expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(Number(readFileSync(lock, "utf8"))).toBe(first.pid);

    const socket = connect(sock);
    await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
    const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    conn.listen();
    const hello = await conn.sendRequest<HelloResult>("hello", {
      protocolVersion: HOST_PROTOCOL_VERSION,
      modelId: DEFAULTS.model,
      threads: 1,
      threadsExplicit: false,
      clientId: "e2e",
      active: true,
    });
    expect(hello.dims).toBe(getModel(DEFAULTS.model).dims);
    conn.dispose();
    socket.destroy();

    const second = startHost();
    expect(await exited(second)).toBe(0);
    expect(first.exitCode).toBeNull();
    expect(Number(readFileSync(lock, "utf8"))).toBe(first.pid);

    first.kill("SIGTERM");
    expect(await exited(first)).toBe(0);
    expect(existsSync(lock)).toBe(false);
    if (process.platform !== "win32") expect(existsSync(sock)).toBe(false);
  }, 60000);
});
