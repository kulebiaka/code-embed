import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBuilt, execCli, makeEnv } from "./helpers";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/sample-repo");
const PROJECTS = 4;

let base: string;
let env: NodeJS.ProcessEnv;
let roots: string[];

beforeEach(() => {
  ensureBuilt();
  base = realpathSync(mkdtempSync(join(tmpdir(), "ce-conc-")));
  env = makeEnv(join(base, "cache"), join(base, "config"));
  roots = Array.from({ length: PROJECTS }, (_, i) => {
    const root = join(base, `repo${i}`);
    mkdirSync(root, { recursive: true });
    cpSync(FIXTURE, root, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    return root;
  });
});
afterEach(async () => {
  await Promise.all(roots.map((cwd) => execCli(["stop"], { cwd, env })));
  rmSync(base, { recursive: true, force: true });
});

describe("several engines sharing one emb.db", () => {
  it("indexes four projects at once without lock errors", async () => {
    const runs = await Promise.all(roots.map((cwd) => execCli(["index"], { cwd, env })));
    for (const r of runs) {
      expect(r.stderr).not.toMatch(/database is locked/);
      expect(r.code).toBe(0);
    }
    for (const cwd of roots) {
      const status = JSON.parse((await execCli(["status", "--json"], { cwd, env })).stdout);
      expect(status.chunks).toBeGreaterThan(0);
      expect(status.embedded).toBe(status.chunks);
    }
  }, 120_000);
});
