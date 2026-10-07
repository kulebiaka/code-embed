import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recentlyChangedPaths } from "./git";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recentlyChangedPaths", () => {
  it("returns [] without git", async () => {
    dir = mkdtempSync(join(tmpdir(), "ce-git-"));
    expect(await recentlyChangedPaths(dir)).toEqual([]);
  });

  it("lists files from recent commits", async () => {
    dir = mkdtempSync(join(tmpdir(), "ce-git-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a");
    writeFileSync(join(dir, "b.ts"), "b");
    git("add", ".");
    git("commit", "-q", "-m", "x");
    expect((await recentlyChangedPaths(dir)).sort()).toEqual(["b.ts", "src/a.ts"]);
  });
});
