import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run } from "./export";
import { run as index } from "./index-cmd";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-export-"));
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

describe("export command", () => {
  it("writes a vectors file with a header", async () => {
    expect(await index(["--root", repo], makeIO().io)).toBe(EXIT.OK);
    const t = makeIO();
    const file = join(tmp, "v.gz");
    expect(await run(["--root", repo, "--out", file], t.io)).toBe(EXIT.OK);
    const raw = gunzipSync(readFileSync(file));
    const header = JSON.parse(raw.subarray(0, raw.indexOf(0x0a)).toString("utf8"));
    expect(header).toMatchObject({ format: "code-embed-vectors", dims: 64 });
    expect(header.count).toBeGreaterThan(0);
    expect(t.out()).toContain(`exported ${header.count} vectors`);
  });

  it("defaults the output file to the current directory", async () => {
    expect(await index(["--root", repo], makeIO().io)).toBe(EXIT.OK);
    expect(await run(["--root", repo], makeIO().io)).toBe(EXIT.OK);
    expect(existsSync(join(tmp, "code-embed-vectors.gz"))).toBe(true);
  });

  it("fails without an index", async () => {
    const t = makeIO();
    expect(await run(["--root", repo], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("no index");
  });
});
