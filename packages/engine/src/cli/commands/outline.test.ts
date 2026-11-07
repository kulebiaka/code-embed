import { PassThrough } from "node:stream";
import { formatOutlineForAgent, type OutlineResponse } from "@code-embed/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run } from "./outline";

const resp: OutlineResponse = {
  path: "src/a.ts",
  lang: "typescript",
  symbols: [{ symbol: "foo", parentSymbol: null, kind: "function", signature: "function foo()", range: { startLine: 1, endLine: 3 } }],
  tookMs: 1,
};
const seen = vi.hoisted(() => ({ params: [] as unknown[] }));
vi.mock("../open", () => ({
  resolveRoot: () => "/proj",
  openForCli: async () => ({
    root: "/proj",
    opened: {
      api: { outline: async (p: unknown) => (seen.params.push(p), resp) },
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

describe("outline command", () => {
  it("requires a path", async () => {
    const t = io();
    expect(await run([], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("outline <PATH>");
  });

  it("rejects paths outside the root", async () => {
    const t = io();
    expect(await run(["/elsewhere/a.ts"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("outside the project root");
  });

  it("prints the agent text with a relative path", async () => {
    const t = io();
    expect(await run(["./src/a.ts"], t.io)).toBe(EXIT.OK);
    expect(seen.params).toEqual([{ path: "src/a.ts" }]);
    expect(t.out()).toBe(`${formatOutlineForAgent(resp).replace(/\n*$/, "\n")}`);
  });

  it("prints the response with --json", async () => {
    const t = io();
    expect(await run(["src/a.ts", "--json"], t.io)).toBe(EXIT.OK);
    expect(JSON.parse(t.out())).toEqual(resp);
  });
});
