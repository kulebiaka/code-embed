import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEngine } from "../engine/service";
import { connectMcp } from "./server";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/sample-repo", import.meta.url));

let tmp: string;
let closers: Array<() => Promise<void>>;

function makeRepo(): string {
  const dir = join(tmp, "repo");
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

async function indexRepo(root: string): Promise<void> {
  const e = await createLocalEngine({ root, clientName: "test", cli: { indexLocation: "project" } });
  await e.ensureLexical();
  await e.close();
}

async function connect(root: string): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = await connectMcp(root, b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  closers.push(async () => {
    await client.close();
    await mcp.close();
  });
  return client;
}

function text(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ce-mcp-"));
  mkdirSync(join(tmp, "cache"));
  mkdirSync(join(tmp, "config"));
  vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "config"));
  vi.stubEnv("CODE_EMBED_FAKE_EMBEDDER", "1");
  vi.stubEnv("CODE_EMBED_FAKE_DIMS", "64");
  closers = [];
});

afterEach(async () => {
  for (const c of closers) await c();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("lists search and find_similar", async () => {
    const client = await connect(makeRepo());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["find_similar", "search"]);
    const search = tools.find((t) => t.name === "search")!;
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(Object.keys(search.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["query", "mode", "top", "include", "exclude", "lang"]),
    );
  });

  it("search returns formatted text", async () => {
    const root = makeRepo();
    await indexRepo(root);
    const client = await connect(root);
    const res = await client.callTool({ name: "search", arguments: { query: "processPaymentRefund", top: 5 } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/src\/payment\/refund\.ts:\d+-\d+ {2}/);
  });

  it("find_similar accepts code and a location", async () => {
    const root = makeRepo();
    await indexRepo(root);
    const client = await connect(root);
    const byCode = await client.callTool({
      name: "find_similar",
      arguments: { code: "function processPaymentRefund(order) {}", lang: "typescript" },
    });
    expect(byCode.isError).toBeFalsy();
    expect(text(byCode)).toContain("src/");
    const byPath = await client.callTool({
      name: "find_similar",
      arguments: { path: "src/payment/refund.ts", start_line: 60, end_line: 70 },
    });
    expect(byPath.isError).toBeFalsy();
  });

  it("find_similar rejects mixed arguments", async () => {
    const root = makeRepo();
    await indexRepo(root);
    const client = await connect(root);
    const res = await client.callTool({ name: "find_similar", arguments: { code: "x", path: "a.ts" } });
    expect(res.isError).toBe(true);
  });

  it("reports a hint and does not index when there is no index", async () => {
    const root = makeRepo();
    const client = await connect(root);
    const res = await client.callTool({ name: "search", arguments: { query: "refund" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("code-embed index");
    expect(existsSync(join(root, ".code-embed"))).toBe(false);
  });
});
