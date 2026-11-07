import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeOutputs } from "../src/report";
import { type RunMetrics, scoreAnswer, summarize, taskValue } from "./score";
import { type AgentTask, readTasks } from "./tasks";

export type AgentConfig = "A" | "B";

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_RUNS = 3;
export const DEFAULT_ENGINE = "packages/engine/dist/cli.js";

const SERVER = "code-embed";
const toolId = (name: string) => `mcp__${SERVER}__${name}`;
const CURRENT_TOOLS = ["search", "find_similar"];
const NEW_TOOLS = ["outline", "references", "context"];

const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(evalDir, "..");

export interface AgentOptions {
  configs: AgentConfig[];
  repos?: string[];
  limit?: number;
  model: string;
  runs: number;
  engine: string;
}

export function parseConfigs(v: string | undefined): AgentConfig[] {
  const s = (v ?? "AB").toUpperCase();
  if (s === "A" || s === "B") return [s];
  if (s === "AB") return ["A", "B"];
  throw new Error("--config must be one of: A, B, AB");
}

function positiveInt(name: string, v: string | undefined, fallback: number | undefined): number | undefined {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

export const AGENT_OPTIONS = {
  config: { type: "string" },
  repos: { type: "string" },
  limit: { type: "string" },
  model: { type: "string" },
  runs: { type: "string" },
  engine: { type: "string" },
  out: { type: "string" },
  name: { type: "string" },
} as const;

export function parseAgentArgs(argv: string[]): AgentOptions & { out?: string; name?: string } {
  const { values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: AGENT_OPTIONS });
  return {
    configs: parseConfigs(values.config),
    repos: values.repos?.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    limit: positiveInt("limit", values.limit, undefined),
    model: values.model ?? DEFAULT_AGENT_MODEL,
    runs: positiveInt("runs", values.runs, DEFAULT_RUNS) ?? DEFAULT_RUNS,
    engine: values.engine ?? DEFAULT_ENGINE,
    out: values.out,
    name: values.name,
  };
}

export function toolsFor(config: AgentConfig): { allowed: string[]; disallowed: string[] } {
  const allowed = (config === "A" ? CURRENT_TOOLS : [...CURRENT_TOOLS, ...NEW_TOOLS]).map(toolId);
  const disallowed = config === "A" ? NEW_TOOLS.map(toolId) : [];
  return { allowed, disallowed };
}

export function buildMcpConfig(engine: string, cwd: string): string {
  return JSON.stringify({
    mcpServers: { [SERVER]: { command: "node", args: [path.resolve(engine), "mcp"], cwd } },
  });
}

export function buildClaudeArgs(opts: { config: AgentConfig; mcpConfigPath: string; model: string; question: string }): string[] {
  const { allowed, disallowed } = toolsFor(opts.config);
  return [
    "-p",
    opts.question,
    "--verbose",
    "--output-format",
    "stream-json",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    "--model",
    opts.model,
    "--allowedTools",
    allowed.join(","),
    "--tools",
    "",
    ...(disallowed.length > 0 ? ["--disallowedTools", disallowed.join(",")] : []),
  ];
}

export interface ParsedRun {
  toolCalls: number;
  tokens: number;
  seconds: number;
  answer: string;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const sumUsage = (u: Usage | undefined) =>
  (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

export function parseStreamJson(stdout: string, wallSeconds: number): ParsedRun {
  let toolCalls = 0;
  let tokens: number | undefined;
  let seconds: number | undefined;
  let answer = "";
  let lastText = "";
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === "tool_use") toolCalls++;
        else if (block?.type === "text" && typeof block.text === "string") lastText = block.text;
      }
    } else if (ev.type === "result") {
      if (typeof ev.result === "string") answer = ev.result;
      if (ev.usage) tokens = sumUsage(ev.usage);
      if (typeof ev.duration_ms === "number") seconds = ev.duration_ms / 1000;
    }
  }
  return { toolCalls, tokens: tokens ?? 0, seconds: seconds ?? wallSeconds, answer: answer || lastText };
}

export function streamFailure(stdout: string): string | undefined {
  let result: Record<string, any> | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "result") result = ev;
    } catch {}
  }
  if (!result) return "no result event in the output";
  if (result.is_error) return `result is an error: ${typeof result.result === "string" ? result.result : (result.subtype ?? "unknown")}`;
  return undefined;
}

export type AgentRun = RunMetrics & { answer: string };

export interface SpawnResult {
  stdout: string;
  code: number | null;
}
export type SpawnFn = (args: string[], cwd: string) => Promise<SpawnResult>;

export const spawnClaude: SpawnFn = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });

export interface TaskResult {
  id: string;
  repo: string;
  category: string;
  runs: AgentRun[];
  value: RunMetrics;
}

export interface ConfigResult {
  config: AgentConfig;
  tasks: TaskResult[];
  summary: RunMetrics;
}

export interface AgentResult {
  model: string;
  createdAt: string;
  runsPerTask: number;
  configs: ConfigResult[];
}

export const indexRepo: RunDeps["index"] = async (engine, cwd) => {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("node", [engine, "index"], { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`indexing ${cwd} with ${engine} failed with exit code ${code}`);
};

export interface RunDeps {
  spawn: SpawnFn;
  index: (engine: string, cwd: string) => Promise<void>;
  reposDir: string;
  tasks: AgentTask[];
  log?: (msg: string) => void;
}

export async function runAgentEval(opts: AgentOptions, deps: RunDeps): Promise<AgentResult> {
  let tasks = deps.tasks;
  if (opts.repos) tasks = tasks.filter((t) => opts.repos!.includes(t.repo));
  if (opts.limit !== undefined) tasks = tasks.slice(0, opts.limit);

  const tmp = mkdtempSync(path.join(tmpdir(), "code-embed-agent-"));
  const mcpConfigPath = path.join(tmp, "mcp.json");
  const configs: ConfigResult[] = [];
  try {
    for (const config of opts.configs) {
      for (const repo of new Set(tasks.map((t) => t.repo))) {
        deps.log?.(`${config}: indexing ${repo}`);
        await deps.index(opts.engine, path.join(deps.reposDir, repo));
      }
      const results: TaskResult[] = [];
      for (const task of tasks) {
        const cwd = path.join(deps.reposDir, task.repo);
        writeFileSync(mcpConfigPath, buildMcpConfig(opts.engine, cwd));
        const runs: AgentRun[] = [];
        for (let i = 1; i <= opts.runs; i++) {
          const t0 = performance.now();
          const res = await deps.spawn(
            buildClaudeArgs({ config, mcpConfigPath, model: opts.model, question: task.question }),
            cwd,
          );
          const failure = res.code !== 0 ? `exit code ${res.code}` : streamFailure(res.stdout);
          if (failure) throw new Error(`agent run failed: config ${config}, task ${task.id}, run ${i}/${opts.runs}: ${failure}`);
          const parsed = parseStreamJson(res.stdout, (performance.now() - t0) / 1000);
          const score = scoreAnswer(parsed.answer, task.mustMention);
          runs.push({ toolCalls: parsed.toolCalls, tokens: parsed.tokens, seconds: parsed.seconds, score, answer: parsed.answer });
          deps.log?.(`${config} ${task.id} run ${i}/${opts.runs}: tools ${parsed.toolCalls}, score ${score.toFixed(2)}`);
        }
        results.push({ id: task.id, repo: task.repo, category: task.category, runs, value: taskValue(runs) });
      }
      configs.push({ config, tasks: results, summary: summarize(results.map((r) => r.value)) });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { model: opts.model, createdAt: new Date().toISOString(), runsPerTask: opts.runs, configs };
}

const f = (v: number, digits = 2) => v.toFixed(digits);
const cells = (m: RunMetrics) => `${f(m.score)} | ${f(m.toolCalls, 1)} | ${f(m.tokens, 0)} | ${f(m.seconds, 1)}`;

export function renderAgentMarkdown(result: AgentResult): string {
  const lines = [`# Agent eval: ${result.model}`, "", `Created: ${result.createdAt}`, ""];
  lines.push(`Runs per task: ${result.runsPerTask}. Per-task values are medians over runs.`, "");
  lines.push("## Summary by configuration", "");
  lines.push("| Config | Tasks | Score | Tool calls | Tokens | Seconds |", "|---|---|---|---|---|---|");
  for (const c of result.configs) lines.push(`| ${c.config} | ${c.tasks.length} | ${cells(c.summary)} |`);
  lines.push("", "## By task", "");
  lines.push("| Config | Task | Repository | Category | Score | Tool calls | Tokens | Seconds |", "|---|---|---|---|---|---|---|---|");
  for (const c of result.configs) {
    for (const t of c.tasks) lines.push(`| ${c.config} | ${t.id} | ${t.repo} | ${t.category} | ${cells(t.value)} |`);
  }
  lines.push("", "Score is the share of mustMention items present in the answer.", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseAgentArgs(process.argv.slice(2));
  const reposDir = path.join(evalDir, ".repos");
  const tasks = readTasks(path.join(evalDir, "agent", "tasks.jsonl"));
  for (const t of tasks) {
    if (opts.repos && !opts.repos.includes(t.repo)) continue;
    if (!existsSync(path.join(reposDir, t.repo))) throw new Error(`clone of "${t.repo}" not found; run fetch-repos first`);
  }
  const result = await runAgentEval(
    { ...opts, engine: path.resolve(repoRoot, opts.engine) },
    { spawn: spawnClaude, index: indexRepo, reposDir, tasks, log: (m) => console.error(m) },
  );
  const stamp = result.createdAt.replace(/[:.]/g, "-");
  const out = writeOutputs(
    opts.out ?? path.join(evalDir, "reports"),
    opts.name ?? `agent-${opts.configs.join("")}-${stamp}`,
    result,
    renderAgentMarkdown(result),
  );
  console.log(out.md);
  console.log(out.json);
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
