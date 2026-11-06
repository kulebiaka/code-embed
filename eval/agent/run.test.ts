import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeOutputs } from "../src/report";
import {
  buildClaudeArgs,
  buildMcpConfig,
  parseAgentArgs,
  parseStreamJson,
  renderAgentMarkdown,
  runAgentEval,
  toolsFor,
} from "./run";
import type { AgentTask } from "./tasks";

const stream = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "mcp__code-embed__search", input: {} }] },
  }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "draft" },
        { type: "tool_use", name: "mcp__code-embed__find_similar", input: {} },
      ],
    },
  }),
  "not json",
  JSON.stringify({
    type: "result",
    result: "See lib/command.js: parse",
    duration_ms: 12500,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 },
  }),
].join("\n");

describe("parseStreamJson", () => {
  it("collects tool calls, tokens, time and answer", () => {
    expect(parseStreamJson(stream, 99)).toEqual({
      toolCalls: 2,
      tokens: 135,
      seconds: 12.5,
      answer: "See lib/command.js: parse",
    });
  });

  it("falls back to wall time and the last assistant text", () => {
    const partial = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(parseStreamJson(partial, 3)).toEqual({ toolCalls: 0, tokens: 0, seconds: 3, answer: "hi" });
  });
});

describe("parseAgentArgs", () => {
  it("defaults to both configs, sonnet-5-5 and 3 runs", () => {
    const o = parseAgentArgs([]);
    expect(o.configs).toEqual(["A", "B"]);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.runs).toBe(3);
    expect(o.engine).toBe("packages/engine/dist/cli.js");
  });

  it("reads flags", () => {
    const o = parseAgentArgs(["--", "--config", "B", "--repos", "cobra, commander", "--limit", "2", "--runs", "1", "--engine", "x.js"]);
    expect(o).toMatchObject({ configs: ["B"], repos: ["cobra", "commander"], limit: 2, runs: 1, engine: "x.js" });
  });

  it("rejects bad values", () => {
    expect(() => parseAgentArgs(["--config", "C"])).toThrow();
    expect(() => parseAgentArgs(["--runs", "0"])).toThrow();
  });
});

describe("claude arguments", () => {
  const base = { mcpConfigPath: "/tmp/mcp.json", model: "claude-sonnet-5-5", question: "Q?" };

  it("passes the headless flags", () => {
    const args = buildClaudeArgs({ ...base, config: "A" });
    expect(args).toEqual(expect.arrayContaining(["-p", "--verbose", "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json", "--model", "claude-sonnet-5-5"]));
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(args.at(-1)).toBe("Q?");
  });

  it("A allows only search and find_similar, B adds the new tools", () => {
    expect(toolsFor("A").allowed).toEqual(["mcp__code-embed__search", "mcp__code-embed__find_similar"]);
    expect(toolsFor("A").disallowed).toEqual(expect.arrayContaining(["mcp__code-embed__outline", "mcp__code-embed__references", "mcp__code-embed__context"]));
    expect(toolsFor("B").allowed).toEqual([
      "mcp__code-embed__search",
      "mcp__code-embed__find_similar",
      "mcp__code-embed__outline",
      "mcp__code-embed__references",
      "mcp__code-embed__context",
    ]);
    expect(toolsFor("B").disallowed.some((t) => t.startsWith("mcp__"))).toBe(false);
  });

  it("builds an mcp config running the engine in the clone", () => {
    const cfg = JSON.parse(buildMcpConfig("/e/cli.js", "/repos/x"));
    expect(cfg.mcpServers["code-embed"]).toEqual({ command: "node", args: ["/e/cli.js", "mcp"], cwd: "/repos/x" });
  });
});

describe("runAgentEval and report", () => {
  const tasks: AgentTask[] = [
    { id: "t1", repo: "r1", question: "Q1", category: "how-works", mustMention: ["a.ts", "foo"] },
    { id: "t2", repo: "r2", question: "Q2", category: "callers", mustMention: ["bar"] },
  ];

  it("runs each task N times per config and writes a report", async () => {
    const calls: string[][] = [];
    const spawn = async (args: string[]) => {
      calls.push(args);
      return { stdout: stream.replace("lib/command.js: parse", "a.ts foo"), code: 0 };
    };
    const opts = { configs: ["A", "B"] as ("A" | "B")[], model: "m", runs: 2, engine: "/e/cli.js", repos: ["r1"] };
    const result = await runAgentEval(opts, { spawn, reposDir: "/repos", tasks });
    expect(calls).toHaveLength(4);
    expect(result.configs.map((c) => c.config)).toEqual(["A", "B"]);
    expect(result.configs[0]!.tasks).toHaveLength(1);
    expect(result.configs[0]!.tasks[0]!.runs).toHaveLength(2);
    expect(result.configs[0]!.summary.score).toBe(1);

    const md = renderAgentMarkdown(result);
    expect(md).toContain("# Agent eval: m");
    expect(md).toContain("| A | t1 | r1 | how-works | 1.00 | 2.0 | 135 | 12.5 |");

    const dir = mkdtempSync(path.join(tmpdir(), "agent-report-"));
    try {
      const out = writeOutputs(dir, "agent-test", result, md);
      expect(path.basename(out.md)).toBe("agent-test.md");
      expect(readFileSync(out.md, "utf8")).toBe(md);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scores a missing mention below 1", async () => {
    const spawn = async () => ({ stdout: stream, code: 0 });
    const result = await runAgentEval(
      { configs: ["A"], model: "m", runs: 1, engine: "/e/cli.js", limit: 2 },
      { spawn, reposDir: "/repos", tasks },
    );
    expect(result.configs[0]!.tasks.map((t) => t.value.score)).toEqual([0, 0]);
  });
});
