import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsDir } from "../../core/paths";
import { DEFAULT_MODEL_ID, getModel } from "../../embed/catalog";
import { EXIT, type CliIO } from "../types";
import { run } from "./model";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-model-"));
  vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "config"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function makeIO(tty = false) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => out.push(String(c)));
  stderr.on("data", (c) => err.push(String(c)));
  const io: CliIO = { stdin: new PassThrough(), stdout, stderr, isTTY: tty, stdoutIsTTY: false, env: process.env, cwd: tmp };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

function fakeInstall(id: string): void {
  for (const f of getModel(id).files) {
    const p = join(modelsDir(), id, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
    truncateSync(p, f.size);
  }
}

describe("model command", () => {
  it("lists the catalog with default mark and without installed", async () => {
    const t = makeIO();
    expect(await run(["list"], t.io)).toBe(EXIT.OK);
    const line = t.out().split("\n").find((l) => l.startsWith(DEFAULT_MODEL_ID))!;
    expect(line).toContain("default");
    expect(line).not.toContain("installed");
  });

  it("marks installed models", async () => {
    fakeInstall(DEFAULT_MODEL_ID);
    const t = makeIO();
    expect(await run(["list", "--json"], t.io)).toBe(EXIT.OK);
    const items = JSON.parse(t.out()) as { id: string; installed: boolean; isDefault: boolean }[];
    expect(items.find((m) => m.id === DEFAULT_MODEL_ID)).toMatchObject({ installed: true, isDefault: true });
  });

  it("install is a no-op for an installed model", async () => {
    fakeInstall(DEFAULT_MODEL_ID);
    const t = makeIO();
    expect(await run(["install"], t.io)).toBe(EXIT.OK);
    expect(t.out()).toContain(`installed ${DEFAULT_MODEL_ID}`);
  });

  it("install --from fails on a bad archive", async () => {
    const file = join(tmp, "bad.tar");
    writeFileSync(file, "not a tar");
    const t = makeIO();
    expect(await run(["install", "--from", file], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("code-embed:");
  });

  it("rejects an unknown model id", async () => {
    const t = makeIO();
    expect(await run(["install", "--model", "nope"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("unknown model");
  });

  it("prints usage for a missing subcommand", async () => {
    const t = makeIO();
    expect(await run([], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("usage:");
  });
});
