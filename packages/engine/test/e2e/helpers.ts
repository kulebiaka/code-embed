import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = join(engineDir, "dist/cli.js");
const FIXTURE = join(engineDir, "test/fixtures/sample-repo");

export function ensureBuilt(): void {
  if (existsSync(CLI)) return;
  const r = spawnSync("pnpm", ["--filter", "code-embed", "build"], { cwd: engineDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  root: string;
  cache: string;
  config: string;
  base: string;
  env: NodeJS.ProcessEnv;
  run(args: string[], opts?: { cwd?: string; input?: string }): Promise<RunResult>;
  cleanup(): Promise<void>;
}

export function makeEnv(cache: string, config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CODE_EMBED_")) env[k] = v;
  return {
    ...env,
    CODE_EMBED_FAKE_EMBEDDER: "1",
    CODE_EMBED_CACHE_DIR: cache,
    CODE_EMBED_CONFIG_DIR: config,
    NODE_NO_WARNINGS: "1",
  };
}

export function execCli(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: opts.cwd, env: opts.env, encoding: "utf8", timeout: 60000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 2) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(opts.input ?? "");
  });
}

export function makeSandbox(): Sandbox {
  ensureBuilt();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ce-e2e-")));
  const root = join(base, "repo");
  const cache = join(base, "cache");
  const config = join(base, "config");
  cpSync(FIXTURE, root, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  const env = makeEnv(cache, config);
  const run: Sandbox["run"] = (args, opts) => execCli(args, { cwd: opts?.cwd ?? root, env, input: opts?.input });
  return {
    root,
    cache,
    config,
    base,
    env,
    run,
    async cleanup() {
      await run(["stop"]);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

export function parseJsonLines(out: string): Record<string, unknown>[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
