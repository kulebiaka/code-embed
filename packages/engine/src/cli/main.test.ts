import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main";
import type { CliIO } from "./types";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-cli-"));
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

async function run(argv: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => out.push(String(c)));
  stderr.on("data", (c) => err.push(String(c)));
  const input = new PassThrough();
  input.end(stdin);
  const io: CliIO = { stdout, stderr, stdin: input, isTTY: false, stdoutIsTTY: false, env: process.env, cwd: repo };
  const code = await main(argv, io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("main", () => {
  it("--version and --help exit 0 on stdout", async () => {
    const v = await run(["--version"]);
    expect(v).toMatchObject({ code: 0, err: "" });
    expect(v.out).toMatch(/^\d+\.\d+\.\d+/);
    const h = await run(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("Usage:");
  });

  it("unknown option goes to stderr with code 2", async () => {
    const r = await run(["--bogus", "q"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("--bogus");
  });

  it("missing query is an error", async () => {
    const r = await run(["--json"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("QUERY");
  });

  it("lexical search on a fresh repo builds the index and prints ripgrep lines", async () => {
    const r = await run(["--root", repo, "-l", "refund"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(/^[^:]+:\d+:\d+: /);
  });

  it("--json emits JSONL; --files-only emits unique paths", async () => {
    const j = await run(["--root", repo, "-l", "--json", "-n", "3", "refund"]);
    expect(j.code).toBe(0);
    for (const line of j.out.trimEnd().split("\n")) {
      expect(Object.keys(JSON.parse(line))).toEqual([
        "path",
        "start_line",
        "end_line",
        "symbol",
        "kind",
        "score",
        "sources",
        "snippet",
      ]);
    }
    const f = await run(["--root", repo, "-l", "--files-only", "refund"]);
    const paths = f.out.trimEnd().split("\n");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("exit 1 when nothing matches", async () => {
    const r = await run(["--root", repo, "-l", "zzqxjvwk"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });

  it("--no-update searches the existing index", async () => {
    await run(["--root", repo, "-l", "refund"]);
    const r = await run(["--root", repo, "-l", "--no-update", "refund"]);
    expect(r.code).toBe(0);
  });

  it("similar with a range and with stdin", async () => {
    const r = await run(["similar", "src/payment/refund.ts:60-70", "--root", repo, "--json", "-n", "3"]);
    expect(r.err).not.toContain("not implemented");
    expect([0, 1]).toContain(r.code);
    const s = await run(["similar", "-", "--lang", "typescript", "--root", repo, "-n", "3"], "function refund(order) {}");
    expect([0, 1]).toContain(s.code);
    const bad = await run(["similar", "nonsense", "--root", repo]);
    expect(bad.code).toBe(2);
  });
});
