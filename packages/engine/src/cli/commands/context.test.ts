import { PassThrough } from "node:stream";
import { formatContextForAgent, type ContextResponse } from "@code-embed/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run } from "./context";

const resp: ContextResponse = {
  chunks: [
    { level: "target", path: "src/a.ts", lang: "typescript", range: { startLine: 1, endLine: 3 }, symbol: "foo", kind: "function", text: "function foo() {}", tokens: 5 },
  ],
  commits: [],
  budgetTokens: 4000,
  usedTokens: 5,
  omitted: [],
  partial: false,
  tookMs: 1,
};
const seen = vi.hoisted(() => ({ params: [] as unknown[] }));
vi.mock("../open", () => ({
  resolveRoot: () => "/proj",
  openForCli: async () => ({
    root: "/proj",
    opened: {
      api: { context: async (p: unknown) => (seen.params.push(p), resp) },
      close: async () => {},
    },
  }),
}));
beforeEach(() => {
  seen.params.length = 0;
});

function io() {
  const err: string[] = [];
  const out: string[] = [];
  const stderr = new PassThrough();
  stderr.on("data", (c) => err.push(String(c)));
  const stdout = new PassThrough();
  stdout.on("data", (c) => out.push(String(c)));
  const o = { stdin: new PassThrough(), stdout, stderr, isTTY: false, stdoutIsTTY: false, env: {}, cwd: "/proj" };
  return { io: o as CliIO, err: () => err.join(""), out: () => out.join("") };
}

describe("context command", () => {
  it("requires a target", async () => {
    const t = io();
    expect(await run([], t.io)).toBe(EXIT.ERROR);
  });

  it("parses <PATH>:<LINE>", async () => {
    const t = io();
    expect(await run(["./src/a.ts:12"], t.io)).toBe(EXIT.OK);
    expect(seen.params).toEqual([{ path: "src/a.ts", line: 12 }]);
    expect(t.out()).toBe(`${formatContextForAgent(resp).replace(/\n*$/, "\n")}`);
  });

  it("treats anything else as a query", async () => {
    await run(["how does", "indexing work"], io().io);
    expect(seen.params).toEqual([{ query: "how does indexing work" }]);
  });

  it("maps --budget to budgetTokens", async () => {
    await run(["src/a.ts:3", "--budget", "1500"], io().io);
    await run(["some query", "--budget", "200"], io().io);
    expect(seen.params).toEqual([
      { path: "src/a.ts", line: 3, budgetTokens: 1500 },
      { query: "some query", budgetTokens: 200 },
    ]);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects invalid --budget %s", async (v) => {
    const t = io();
    expect(await run(["q", `--budget=${v}`], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("--budget expects an integer >= 1");
    expect(seen.params).toEqual([]);
  });

  it("rejects line 0 and paths outside the root", async () => {
    const t = io();
    expect(await run(["src/a.ts:0"], t.io)).toBe(EXIT.ERROR);
    expect(await run(["/elsewhere/a.ts:3"], t.io)).toBe(EXIT.ERROR);
  });

  it("prints the response with --json", async () => {
    const t = io();
    expect(await run(["q", "--json"], t.io)).toBe(EXIT.OK);
    expect(JSON.parse(t.out())).toEqual(resp);
  });
});
