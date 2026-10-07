import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createLocalEngine } from "../../packages/engine/src/engine/service";
import { DEFAULT_MODEL_ID } from "../../packages/engine/src/embed/catalog";
import { modelsDir } from "../../packages/engine/src/core/paths";
import { type QueryScore, TOP_K, aggregate, percentile, scoreQuery } from "./metrics";
import { type RunReport, type RunResult, checkNr10, renderMarkdown, writeOutputs } from "./report";
import type { EvalMode, EvalQuery, EvalRepo } from "./types";

export const ALL_MODES: EvalMode[] = ["lexical", "semantic", "hybrid"];

const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface RunOptions {
  model: string;
  modes: EvalMode[];
  repos: EvalRepo[];
  reposDir: string;
  datasetsDir: string;
  limit?: number;
  fake?: boolean;
}

export function readDataset(file: string): EvalQuery[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as EvalQuery);
}

const ENV_KEYS = ["CODE_EMBED_CACHE_DIR", "CODE_EMBED_CONFIG_DIR", "CODE_EMBED_FAKE_EMBEDDER"] as const;

export async function runEval(opts: RunOptions): Promise<RunResult> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const realModels = modelsDir();
  const tmp = mkdtempSync(path.join(tmpdir(), "code-embed-eval-"));
  process.env.CODE_EMBED_CACHE_DIR = path.join(tmp, "cache");
  process.env.CODE_EMBED_CONFIG_DIR = path.join(tmp, "config");
  mkdirSync(process.env.CODE_EMBED_CACHE_DIR, { recursive: true });
  if (opts.fake) {
    process.env.CODE_EMBED_FAKE_EMBEDDER = "1";
  } else {
    delete process.env.CODE_EMBED_FAKE_EMBEDDER;
    mkdirSync(realModels, { recursive: true });
    symlinkSync(realModels, modelsDir(), "dir");
  }

  const scores = new Map<EvalMode, QueryScore[]>(opts.modes.map((m) => [m, []]));
  const latencies = new Map<EvalMode, number[]>(opts.modes.map((m) => [m, []]));
  let indexSeconds = 0;
  let chunks = 0;
  try {
    for (const repo of opts.repos) {
      const root = path.join(opts.reposDir, repo.name);
      if (!existsSync(root)) throw new Error(`clone of "${repo.name}" not found at ${root}; run fetch-repos first`);
      let queries = readDataset(path.join(opts.datasetsDir, `${repo.name}.jsonl`));
      if (opts.limit !== undefined) queries = queries.slice(0, opts.limit);

      const engine = await createLocalEngine({
        root,
        clientName: "code-embed-eval",
        cli: { indexLocation: "cache", provider: "local", model: opts.model },
        watch: false,
        vectorPhase: false,
      });
      try {
        const t0 = performance.now();
        await engine.indexAll({ full: true });
        indexSeconds += (performance.now() - t0) / 1000;
        chunks += (await engine.status()).chunks;

        for (const mode of opts.modes) {
          for (const query of queries) {
            const t = performance.now();
            const res = await engine.search({ query: query.query, mode, top: TOP_K });
            latencies.get(mode)?.push(performance.now() - t);
            scores.get(mode)?.push(
              scoreQuery(
                query,
                res.results.map((r) => ({ path: r.path, startLine: r.range.startLine, endLine: r.range.endLine })),
              ),
            );
          }
        }
      } finally {
        await engine.close();
      }
      console.error(`${repo.name}: ${queries.length} queries, ${modesLabel(opts.modes)}`);
    }
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  const createdAt = new Date().toISOString();
  const rssMb = process.resourceUsage().maxRSS / 1024;
  const reports: RunReport[] = opts.modes.map((mode) => ({
    model: opts.model,
    mode,
    createdAt,
    ...aggregate(scores.get(mode) ?? []),
    indexSeconds,
    chunksPerSec: indexSeconds > 0 ? chunks / indexSeconds : 0,
    rssMb,
    latencyMs: {
      p50: percentile(latencies.get(mode) ?? [], 50),
      p95: percentile(latencies.get(mode) ?? [], 95),
    },
  }));
  return { model: opts.model, createdAt, reports, nr10: checkNr10(reports) };
}

const modesLabel = (modes: EvalMode[]) => modes.join("/");

export function parseModes(v: string | undefined): EvalMode[] {
  if (v === undefined || v === "all") return ALL_MODES;
  if (!ALL_MODES.includes(v as EvalMode)) throw new Error(`--mode must be one of: all, ${ALL_MODES.join(", ")}`);
  return [v as EvalMode];
}

export function selectRepos(all: EvalRepo[], names: string | undefined): EvalRepo[] {
  if (names === undefined) return all;
  const wanted = names.split(",").map((s) => s.trim());
  const unknown = wanted.filter((n) => !all.some((r) => r.name === n));
  if (unknown.length > 0) throw new Error(`unknown repos: ${unknown.join(", ")}`);
  return all.filter((r) => wanted.includes(r.name));
}

export const RUN_OPTIONS = {
  model: { type: "string" },
  mode: { type: "string" },
  repos: { type: "string" },
  limit: { type: "string" },
  fake: { type: "boolean" },
  strict: { type: "boolean" },
  out: { type: "string" },
  name: { type: "string" },
} as const;

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({ args: argv, options: RUN_OPTIONS });
  const allRepos = JSON.parse(readFileSync(path.join(evalDir, "repos.json"), "utf8")) as EvalRepo[];
  const model = values.fake ? "fake" : (values.model ?? DEFAULT_MODEL_ID);
  const result = await runEval({
    model,
    modes: parseModes(values.mode),
    repos: selectRepos(allRepos, values.repos),
    reposDir: path.join(evalDir, ".repos"),
    datasetsDir: path.join(evalDir, "datasets"),
    limit: values.limit === undefined ? undefined : Number(values.limit),
    fake: values.fake,
  });
  const stamp = result.createdAt.replace(/[:.]/g, "-");
  const out = writeOutputs(
    values.out ?? path.join(evalDir, "reports"),
    values.name ?? `eval-${model}-${stamp}`,
    result,
    renderMarkdown(result),
  );
  console.log(out.md);
  console.log(out.json);
  if (result.nr10) {
    console.error(result.nr10.ok ? "NR-10: ok" : "NR-10: FAILED (hybrid < max(lexical, semantic))");
    if (!result.nr10.ok && values.strict) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
