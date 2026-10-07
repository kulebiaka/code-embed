import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

async function connect(root: string, cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--root", root],
    cwd,
    env: sb.env as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (res: unknown): string =>
  ((res as { content: { type: string; text: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("mcp (R-112, R-113, R-114)", () => {
  it("lists tools and answers search over stdio without a daemon", async () => {
    expect((await sb.run(["index"])).code).toBe(0);
    const client = await connect(sb.root, sb.base);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("search");
      expect(names).toContain("find_similar");

      const res = await client.callTool({ name: "search", arguments: { query: "refund payment" } });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("src/payment/refund.ts");

      const sim = await client.callTool({
        name: "find_similar",
        arguments: { path: "src/payment/refund.ts", start_line: 33, end_line: 45 },
      });
      expect(sim.isError).toBeFalsy();
      expect(textOf(sim).length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("works through a running daemon", async () => {
    expect((await sb.run(["index"])).code).toBe(0);
    expect((await sb.run(["daemon", "--detach"])).code).toBe(0);
    const client = await connect(sb.root, sb.base);
    try {
      const res = await client.callTool({ name: "search", arguments: { query: "refund payment" } });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("src/payment/refund.ts");
    } finally {
      await client.close();
    }
  });

  it("reports a missing index with a hint and does not index on its own", async () => {
    const client = await connect(sb.root, sb.base);
    try {
      const res = await client.callTool({ name: "search", arguments: { query: "refund" } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("code-embed index");
    } finally {
      await client.close();
    }
    const status = await sb.run(["status", "--json"]);
    expect(JSON.parse(status.stdout).chunks).toBe(0);
  });
});
