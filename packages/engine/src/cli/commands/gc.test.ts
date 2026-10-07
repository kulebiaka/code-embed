import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEmbCache } from "../../cache/embcache";
import { embCachePath } from "../../core/paths";
import { EXIT, type CliIO } from "../types";
import { run } from "./gc";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-gc-"));
  vi.stubEnv("CODE_EMBED_CACHE_DIR", tmp);
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

function seed(n: number): void {
  const cache = openEmbCache(embCachePath());
  cache.put(
    "m",
    Array.from({ length: n }, (_, i) => ({ chunkHash: i.toString(16).padStart(64, "0"), vector: new Float32Array([1, 0]) })),
  );
  cache.close();
}

describe("gc command", () => {
  it("removes nothing fresh with the default 30 days", async () => {
    seed(3);
    const t = makeIO();
    expect(await run([], t.io)).toBe(EXIT.OK);
    expect(t.out()).toBe("0\n");
  });

  it("removes entries older than --days", async () => {
    seed(3);
    await new Promise((r) => setTimeout(r, 10));
    const t = makeIO();
    expect(await run(["--days", "0"], t.io)).toBe(EXIT.OK);
    expect(t.out()).toBe("3\n");
    const cache = openEmbCache(embCachePath());
    expect(cache.count()).toBe(0);
    cache.close();
  });

  it("rejects a bad --days", async () => {
    const t = makeIO();
    expect(await run(["--days", "x"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("--days");
  });
});
