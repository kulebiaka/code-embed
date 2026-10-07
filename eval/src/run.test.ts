import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseModes, runEval, selectRepos } from "./run";
import type { EvalQuery, EvalRepo } from "./types";

const repo: EvalRepo = { name: "mini", url: "x", commit: "y", languages: ["typescript"], license: "MIT" };
let dir: string;

const lines = (n: number) => Array.from({ length: n }, (_, i) => `// filler ${i}`).join("\n");

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "run-test-"));
  const root = path.join(dir, "repos", "mini");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "alpha.ts"),
    `export function parseZebraConfiguration(input: string) {\n  return input.split("zebra");\n}\n${lines(5)}\n`,
  );
  writeFileSync(
    path.join(root, "src", "beta.ts"),
    `export function renderGiraffeTemplate(name: string) {\n  return "giraffe " + name;\n}\n${lines(5)}\n`,
  );
  const queries: EvalQuery[] = [
    { id: "q1", repo: "mini", query: "parseZebraConfiguration", lang: "en", expected: [{ path: "src/alpha.ts", startLine: 1, endLine: 3 }] },
    { id: "q2", repo: "mini", query: "renderGiraffeTemplate", lang: "ru", expected: [{ path: "src/beta.ts", startLine: 1, endLine: 3 }] },
    { id: "q3", repo: "mini", query: "unused", lang: "en", expected: [{ path: "src/alpha.ts", startLine: 1, endLine: 3 }] },
  ];
  mkdirSync(path.join(dir, "datasets"));
  writeFileSync(path.join(dir, "datasets", "mini.jsonl"), `${queries.map((q) => JSON.stringify(q)).join("\n")}\n`);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runEval", () => {
  it("indexes a repo with the fake embedder and scores all modes", async () => {
    const before = process.env.CODE_EMBED_CACHE_DIR;
    const result = await runEval({
      model: "fake",
      modes: ["lexical", "semantic", "hybrid"],
      repos: [repo],
      reposDir: path.join(dir, "repos"),
      datasetsDir: path.join(dir, "datasets"),
      limit: 2,
      fake: true,
    });
    expect(process.env.CODE_EMBED_CACHE_DIR).toBe(before);
    expect(result.reports.map((r) => r.mode)).toEqual(["lexical", "semantic", "hybrid"]);
    const lexical = result.reports[0];
    expect(lexical?.overall.count).toBe(2);
    expect(lexical?.ru.count).toBe(1);
    expect(lexical?.overall.recallAt10).toBe(1);
    expect(lexical?.perRepo.mini?.count).toBe(2);
    expect(lexical?.chunksPerSec).toBeGreaterThan(0);
    expect(result.nr10).not.toBeNull();
  });

  it("fails clearly when the clone is missing", async () => {
    await expect(
      runEval({
        model: "fake",
        modes: ["lexical"],
        repos: [{ ...repo, name: "absent" }],
        reposDir: path.join(dir, "repos"),
        datasetsDir: path.join(dir, "datasets"),
        fake: true,
      }),
    ).rejects.toThrow(/fetch-repos/);
  });
});

describe("option parsing", () => {
  it("parses modes", () => {
    expect(parseModes(undefined)).toEqual(["lexical", "semantic", "hybrid"]);
    expect(parseModes("hybrid")).toEqual(["hybrid"]);
    expect(() => parseModes("nope")).toThrow();
  });

  it("selects repos", () => {
    const all = [repo, { ...repo, name: "other" }];
    expect(selectRepos(all, "other").map((r) => r.name)).toEqual(["other"]);
    expect(selectRepos(all, undefined)).toHaveLength(2);
    expect(() => selectRepos(all, "zzz")).toThrow(/unknown/);
  });
});
