import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, type CliIO } from "../types";
import { ErrorCodes } from "@code-embed/protocol";
import { openForCli } from "../open";
import { run } from "./index-cmd";
import { run as status } from "./status";

vi.mock("../open", async (importActual) => {
  const actual = await importActual<typeof import("../open")>();
  return { ...actual, openForCli: vi.fn(actual.openForCli) };
});

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-index-"));
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

describe("index command", () => {
  it("indexes to the end and reports progress on stderr", async () => {
    const t = makeIO();
    expect(await run(["--root", repo], t.io)).toBe(EXIT.OK);
    expect(existsSync(join(repo, ".code-embed", "index.db"))).toBe(true);
    expect(t.err()).toMatch(/scanning: \d+\/\d+/);
    expect(t.err()).toMatch(/indexed \d+ files, \d+ chunks, vectors (\d+)\/\1/);
    expect(t.out()).toBe("");

    const s = makeIO();
    expect(await status(["--root", repo, "--json"], s.io)).toBe(EXIT.OK);
    const st = JSON.parse(s.out());
    expect(st.chunks).toBeGreaterThan(0);
    expect(st.embedded).toBe(st.chunks);
  });

  it("supports --full", async () => {
    expect(await run(["--root", repo], makeIO().io)).toBe(EXIT.OK);
    const t = makeIO();
    expect(await run(["--root", repo, "--full"], t.io)).toBe(EXIT.OK);
    expect(t.err()).toContain("indexed");
  });

  it("keeps watching until SIGINT with --watch", async () => {
    const t = makeIO();
    const done = run(["--root", repo, "--watch"], t.io);
    await vi.waitFor(() => expect(t.err()).toContain("watching for changes"), { timeout: 20000 });
    process.emit("SIGINT");
    expect(await done).toBe(EXIT.OK);
  });

  it("exits 2 on an unknown option", async () => {
    const t = makeIO();
    expect(await run(["--nope"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("code-embed:");
  });
});

describe("index command via daemon", () => {
  function fakeDaemon(rebuild: () => Promise<unknown>) {
    const opened = {
      viaDaemon: true,
      api: {
        rebuild,
        status: async () => ({ phase: "idle", files: 3, chunks: 5, embedded: 5 }),
        onProgress: () => ({ dispose() {} }),
        grantConsent: async () => undefined,
      },
      close: async () => {},
    };
    vi.mocked(openForCli).mockResolvedValueOnce({ root: tmp, opened } as never);
  }

  it.each([null, undefined])("treats a successful %s rebuild response as success", async (value) => {
    fakeDaemon(async () => value);
    const t = makeIO();
    expect(await run([], t.io)).toBe(EXIT.OK);
    expect(t.err()).toContain("indexed 3 files, 5 chunks, vectors 5/5");
  });

  it("still fails when consent is required and not granted", async () => {
    fakeDaemon(async () => {
      throw Object.assign(new Error("consent required"), {
        code: ErrorCodes.ConsentRequired,
        data: { host: "api.example.com" },
      });
    });
    const t = makeIO();
    expect(await run([], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("--allow-remote");
    expect(t.err()).not.toContain("indexed");
  });
});
