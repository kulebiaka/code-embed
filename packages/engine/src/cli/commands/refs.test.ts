import { PassThrough } from "node:stream";
import { formatReferencesForAgent, type ReferencesResponse } from "@code-embed/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run } from "./refs";

const resp: ReferencesResponse = {
  symbol: "foo",
  items: [
    {
      role: "definition",
      path: "src/a.ts",
      lang: "typescript",
      range: { startLine: 1, endLine: 3 },
      line: 1,
      symbol: "foo",
      kind: "function",
      confidence: "high",
      text: "function foo()",
    },
  ],
  truncated: false,
  tookMs: 1,
};
const seen = vi.hoisted(() => ({ params: [] as unknown[] }));
vi.mock("../open", () => ({
  resolveRoot: () => "/proj",
  openForCli: async () => ({
    root: "/proj",
    opened: {
      api: { references: async (p: unknown) => (seen.params.push(p), resp) },
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

describe("refs command", () => {
  it("requires a symbol", async () => {
    const t = io();
    expect(await run([], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("refs <SYMBOL>");
  });

  it("passes only the symbol without --path", async () => {
    const t = io();
    expect(await run(["foo"], t.io)).toBe(EXIT.OK);
    expect(seen.params).toEqual([{ symbol: "foo" }]);
    expect(t.out()).toBe(`${formatReferencesForAgent(resp).replace(/\n*$/, "\n")}`);
  });

  it("maps --path to the path parameter, relative to the root", async () => {
    const t = io();
    expect(await run(["foo", "--path", "./src/a.ts"], t.io)).toBe(EXIT.OK);
    expect(seen.params).toEqual([{ symbol: "foo", path: "src/a.ts" }]);
  });

  it("rejects --path outside the root", async () => {
    const t = io();
    expect(await run(["foo", "--path", "/elsewhere/a.ts"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("outside the project root");
  });

  it("prints the response with --json", async () => {
    const t = io();
    expect(await run(["foo", "--json"], t.io)).toBe(EXIT.OK);
    expect(JSON.parse(t.out())).toEqual(resp);
  });
});
