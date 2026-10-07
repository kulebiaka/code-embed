import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { EXIT, type CliIO } from "../types";
import { run } from "./search";

function io() {
  const err: string[] = [];
  const stderr = new PassThrough();
  stderr.on("data", (c) => err.push(String(c)));
  const out = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, isTTY: false, stdoutIsTTY: false, env: {}, cwd: "/" };
  return { io: out as CliIO, err: () => err.join("") };
}

describe("search command", () => {
  it("exits 2 with usage for an unknown option", async () => {
    const t = io();
    expect(await run(["--nope", "q"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("Usage:");
  });

  it("exits 2 for conflicting modes", async () => {
    const t = io();
    expect(await run(["-s", "-l", "q"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("mutually exclusive");
  });
});
