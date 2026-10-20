import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI, ensureBuilt } from "./helpers";

const children: ChildProcess[] = [];

beforeAll(() => ensureBuilt());

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
});

function worker(): ChildProcess {
  const c = fork(CLI, ["__embed-worker"], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced",
  });
  children.push(c);
  return c;
}

describe("__embed-worker (bundle)", () => {
  it("answers load for an unknown model with an error response", async () => {
    const c = worker();
    const res = await new Promise<{ id: number; ok: boolean; error?: { message: string } }>((resolve, reject) => {
      c.once("message", resolve as (m: unknown) => void);
      c.once("error", reject);
      c.send({ id: 1, op: "load", model: "nope", opts: { modelsDir: "/nonexistent", threads: 1 } });
    });
    expect(res).toMatchObject({ id: 1, ok: false });
    expect(res.error?.message).toContain("unknown model");
  }, 15000);

  it("exits within 2s after the parent disconnects", async () => {
    const c = worker();
    await new Promise<void>((resolve, reject) => {
      c.once("message", () => resolve());
      c.once("error", reject);
      c.send({ id: 1, op: "load", model: "nope", opts: { modelsDir: "/nonexistent", threads: 1 } });
    });
    const exited = new Promise<void>((resolve) => c.once("exit", () => resolve()));
    const t0 = Date.now();
    c.disconnect();
    await exited;
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 15000);

  it("refuses to run without an IPC channel", () => {
    const r = spawnSync(process.execPath, [CLI, "__embed-worker"], { encoding: "utf8", timeout: 15000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("is hidden from --help", () => {
    const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 15000 });
    expect(r.stdout + r.stderr).not.toContain("__embed-worker");
  });
});
