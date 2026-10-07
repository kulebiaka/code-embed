import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "./open";
import type { CliIO } from "./types";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ce-open-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveRoot", () => {
  it("uses --root relative to cwd", () => {
    expect(resolveRoot({ cwd: tmp } as CliIO, { root: "sub" })).toBe(join(tmp, "sub"));
  });

  it("falls back to the nearest project root", () => {
    mkdirSync(join(tmp, ".git"));
    mkdirSync(join(tmp, "a", "b"), { recursive: true });
    expect(resolveRoot({ cwd: join(tmp, "a", "b") } as CliIO, {})).toBe(tmp);
  });
});
