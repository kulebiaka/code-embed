import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadManifest } from "../../packages/engine/src/embed/catalog";
import { type BenchRow, type RunResult, benchRow, renderBenchMarkdown, writeOutputs } from "./report";

const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runScript = path.join(evalDir, "src", "run.ts");

export type RunModel = (model: string, passthrough: string[]) => Promise<RunResult>;

// A separate process per model keeps peak RSS from leaking between models.
export const runModelInChild: RunModel = async (model, passthrough) => {
  const out = mkdtempSync(path.join(tmpdir(), "code-embed-bench-"));
  try {
    const args = ["--import", "tsx", runScript, "--model", model, "--out", out, "--name", "result", ...passthrough];
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: evalDir, stdio: ["ignore", "ignore", "inherit"] });
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0) throw new Error(`run exited with code ${code}`);
    return JSON.parse(readFileSync(path.join(out, "result.json"), "utf8")) as RunResult;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

export async function runBench(models: string[], passthrough: string[], run: RunModel = runModelInChild): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const model of models) {
    console.error(`bench: ${model}`);
    try {
      rows.push(benchRow(model, (await run(model, passthrough)).reports));
    } catch (e) {
      rows.push({ model, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      models: { type: "string" },
      repos: { type: "string" },
      limit: { type: "string" },
      fake: { type: "boolean" },
      out: { type: "string" },
    },
  });
  const catalog = loadManifest().models.map((m) => m.id);
  const models = values.models ? values.models.split(",").map((s) => s.trim()) : catalog;
  const unknown = models.filter((m) => !catalog.includes(m));
  if (unknown.length > 0) throw new Error(`unknown models: ${unknown.join(", ")} (available: ${catalog.join(", ")})`);

  const passthrough = ["--mode", "all"];
  if (values.repos) passthrough.push("--repos", values.repos);
  if (values.limit) passthrough.push("--limit", values.limit);
  if (values.fake) passthrough.push("--fake");

  const rows = await runBench(models, passthrough);
  const createdAt = new Date().toISOString();
  const out = writeOutputs(
    values.out ?? path.join(evalDir, "reports"),
    `bench-${createdAt.replace(/[:.]/g, "-")}`,
    { createdAt, rows },
    renderBenchMarkdown(rows, createdAt),
  );
  console.log(out.md);
  console.log(out.json);
  if (rows.some((r) => r.error)) process.exitCode = 1;
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
