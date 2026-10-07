import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run as index } from "./index-cmd";
import { run } from "./status";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-status-"));
  mkdirSync(join(tmp, "cache"));
  mkdirSync(join(tmp, "config"));
  repo = join(tmp, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "config"));
  vi.stubEnv("CODE_EMBED_FAKE_EMBEDDER", "1");
  vi.stubEnv("CODE_EMBED_FAKE_DIMS", "64");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function makeIO() {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => out.push(String(c)));
  stderr.on("data", (c) => err.push(String(c)));
  const io: CliIO = {
    stdin: new PassThrough(),
    stdout,
    stderr,
    isTTY: false,
    stdoutIsTTY: false,
    env: process.env,
    cwd: tmp,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("status command", () => {
  it("reports a missing index without creating one", async () => {
    const t = makeIO();
    expect(await run(["--root", repo, "--json"], t.io)).toBe(EXIT.OK);
    const st = JSON.parse(t.out());
    expect(st.root).toBe(repo);
    expect(st.chunks).toBe(0);
    expect(st.daemon).toBe(false);
    expect(st.lastError).toContain("no index");
  });

  it("prints text with provider destination and vector percentage", async () => {
    expect(await index(["--root", repo], makeIO().io)).toBe(EXIT.OK);
    const t = makeIO();
    expect(await run(["--root", repo], t.io)).toBe(EXIT.OK);
    const text = t.out();
    expect(text).toContain(`root:       ${repo}`);
    expect(text).toContain(".code-embed");
    expect(text).toContain("provider:   local");
    expect(text).toContain("nothing leaves this machine");
    expect(text).toContain("(100%)");
    expect(text).toContain("daemon:     not running");
  });

  it("--json is machine readable", async () => {
    expect(await index(["--root", repo], makeIO().io)).toBe(EXIT.OK);
    const t = makeIO();
    expect(await run(["--root", repo, "--json"], t.io)).toBe(EXIT.OK);
    const st = JSON.parse(t.out());
    expect(st).toMatchObject({ provider: "local", remote: false, daemon: false });
    expect(st.files).toBeGreaterThan(0);
  });
});
