import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { socketPath } from "../../core/paths";
import { initHashing } from "../../util/hash";
import { EXIT, type CliIO } from "../types";
import { run } from "./clean";

let tmp: string;
let root: string;
let server: Server | undefined;
let sockTmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ce-clean-")));
  root = join(tmp, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".code-embed"));
  vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "config"));
  sockTmp = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "ce-"));
  vi.stubEnv("TMPDIR", sockTmp);
  vi.stubEnv("XDG_RUNTIME_DIR", sockTmp);
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(sockTmp, { recursive: true, force: true });
});

function makeIO(tty: boolean, input = "") {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdout.on("data", (c) => out.push(String(c)));
  stderr.on("data", (c) => err.push(String(c)));
  if (input) stdin.end(input);
  const io: CliIO = { stdin, stdout, stderr, isTTY: tty, stdoutIsTTY: false, env: process.env, cwd: root };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("clean command", () => {
  it("removes the index with --yes", async () => {
    expect(await run(["--yes"], makeIO(false).io)).toBe(EXIT.OK);
    expect(existsSync(join(root, ".code-embed"))).toBe(false);
  });

  it("refuses without confirmation when not a TTY", async () => {
    const t = makeIO(false);
    expect(await run([], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("--yes");
    expect(existsSync(join(root, ".code-embed"))).toBe(true);
  });

  it("asks in a TTY and honours the answer", async () => {
    expect(await run([], makeIO(true, "n\n").io)).toBe(EXIT.ERROR);
    expect(existsSync(join(root, ".code-embed"))).toBe(true);
    expect(await run([], makeIO(true, "y\n").io)).toBe(EXIT.OK);
    expect(existsSync(join(root, ".code-embed"))).toBe(false);
  });

  it("refuses while a daemon is running", async () => {
    await initHashing();
    const sock = socketPath(root);
    mkdirSync(dirname(sock), { recursive: true });
    server = createServer();
    await new Promise<void>((r) => server!.listen(sock, r));
    const t = makeIO(false);
    expect(await run(["--yes"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("code-embed stop");
    expect(existsSync(join(root, ".code-embed"))).toBe(true);
  });
});
