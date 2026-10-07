import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run } from "./similar";

function io(stdin = "") {
  const err: string[] = [];
  const stderr = new PassThrough();
  stderr.on("data", (c) => err.push(String(c)));
  const input = new PassThrough();
  input.end(stdin);
  const out = { stdin: input, stdout: new PassThrough(), stderr, isTTY: false, stdoutIsTTY: false, env: {}, cwd: "/proj" };
  return { io: out as CliIO, err: () => err.join("") };
}

describe("similar command", () => {
  it("requires a target", async () => {
    const t = io();
    expect(await run([], t.io)).toBe(EXIT.ERROR);
  });

  it("rejects a malformed location", async () => {
    const t = io();
    expect(await run(["src/a.ts"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("<PATH>:<START>-<END>");
  });

  it("rejects an inverted range", async () => {
    const t = io();
    expect(await run(["src/a.ts:9-3", "--root", "/proj"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("invalid line range");
  });

  it("rejects paths outside the root", async () => {
    const t = io();
    expect(await run(["/elsewhere/a.ts:1-2", "--root", "/proj"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("outside the project root");
  });

  it("rejects empty stdin", async () => {
    const t = io("  ");
    expect(await run(["-"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("no code received");
  });
});
