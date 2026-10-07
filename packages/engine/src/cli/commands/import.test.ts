import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEmbCache } from "../../cache/embcache";
import { embCachePath } from "../../core/paths";
import { EXIT, type CliIO } from "../types";
import { run as exportCmd } from "./export";
import { run } from "./import";
import { run as index } from "./index-cmd";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-import-"));
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

async function exported(): Promise<string> {
  expect(await index(["--root", repo], makeIO().io)).toBe(EXIT.OK);
  const file = join(tmp, "v.gz");
  expect(await exportCmd(["--root", repo, "--out", file], makeIO().io)).toBe(EXIT.OK);
  return file;
}

describe("import command", () => {
  it("adds the vectors to emb.db", async () => {
    const file = await exported();
    rmSync(embCachePath(), { force: true });
    rmSync(`${embCachePath()}-wal`, { force: true });
    rmSync(`${embCachePath()}-shm`, { force: true });
    const t = makeIO();
    expect(await run(["--root", repo, file], t.io)).toBe(EXIT.OK);
    const n = Number(/imported (\d+) vectors/.exec(t.out())![1]);
    expect(n).toBeGreaterThan(0);
    const cache = openEmbCache(embCachePath());
    expect(cache.count()).toBe(n);
    cache.close();
  });

  it("exits 2 on a dims mismatch", async () => {
    const file = await exported();
    vi.stubEnv("CODE_EMBED_FAKE_DIMS", "32");
    const t = makeIO();
    expect(await run(["--root", repo, file], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toMatch(/dims mismatch|model_id mismatch/);
  });

  it("requires a file argument", async () => {
    const t = makeIO();
    expect(await run(["--root", repo], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("usage");
  });
});
