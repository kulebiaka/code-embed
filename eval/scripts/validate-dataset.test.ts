import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDataset } from "./validate-dataset";

const sha = "a".repeat(40);
const repo = (name: string, language: string) => ({ name, url: `https://example.com/${name}`, commit: sha, languages: [language], license: "MIT" });
const repos = [repo("a", "python"), repo("b", "go"), repo("c", "rust")];

const q = (repoName: string, n: number, lang: "ru" | "en", extra: object = {}) =>
  JSON.stringify({
    id: `${repoName}-${n}`,
    repo: repoName,
    query: lang === "ru" ? `запрос номер ${n}` : `query number ${n}`,
    lang,
    expected: [{ path: "src/main.txt", startLine: 1, endLine: 3 }],
    ...extra,
  });

const dataset = (name: string, total: number, ru: number) =>
  Array.from({ length: total }, (_, i) => q(name, i, i < ru ? "ru" : "en")).join("\n") + "\n";

const small = { minPerRepo: 6 };
const good = { a: dataset("a", 6, 3), b: dataset("b", 6, 2), c: dataset("c", 6, 6) };

let reposDir: string;
beforeAll(() => {
  reposDir = mkdtempSync(path.join(tmpdir(), "eval-validate-"));
  for (const name of ["a", "b", "c"]) {
    mkdirSync(path.join(reposDir, name, "src"), { recursive: true });
    writeFileSync(path.join(reposDir, name, "src", "main.txt"), "one\ntwo\nthree\nfour\n");
  }
});
afterAll(() => rmSync(reposDir, { recursive: true, force: true }));

describe("validateDataset", () => {
  it("accepts a consistent dataset and checks ranges against clones", () => {
    const r = validateDataset({ repos, datasets: good, reposDir, ...small });
    expect(r.errors).toEqual([]);
    expect(r.stats.a).toEqual({ count: 6, ru: 3, checkedAgainstClone: true });
  });

  it("skips path checks when repositories are not cloned", () => {
    const r = validateDataset({ repos, datasets: good, reposDir: path.join(reposDir, "missing"), ...small });
    expect(r.errors).toEqual([]);
    expect(r.stats.a?.checkedAgainstClone).toBe(false);
  });

  it("fails on too few repos, too few queries and a low Russian share", () => {
    expect(validateDataset({ repos: repos.slice(0, 2), datasets: good, ...small }).errors.join("\n")).toMatch(/expected 3-5/);
    expect(validateDataset({ repos, datasets: { ...good, a: dataset("a", 5, 3) }, ...small }).errors.join("\n")).toMatch(/a: 5 queries, need at least 6/);
    expect(validateDataset({ repos, datasets: { ...good, b: dataset("b", 6, 1) }, ...small }).errors.join("\n")).toMatch(/b: Russian share 1\/6/);
  });

  it("fails on a missing dataset file", () => {
    const { c: _c, ...rest } = good;
    expect(validateDataset({ repos, datasets: rest, ...small }).errors).toContain("datasets/c.jsonl: missing");
  });

  it("fails on schema violations", () => {
    const bad = [
      "not json",
      q("a", 100, "en", { expected: [] }),
      q("a", 101, "en", { expected: [{ path: "src/main.txt", startLine: 3, endLine: 1 }] }),
      q("a", 102, "en", { lang: "de" }),
      q("a", 103, "ru", { query: "latin only" }),
      q("a", 104, "en", { repo: "other" }),
      q("a", 5, "en", { id: "a-0" }),
    ].join("\n");
    const errors = validateDataset({ repos, datasets: { ...good, a: good.a + bad }, ...small }).errors.join("\n");
    expect(errors).toMatch(/a\.jsonl:7: invalid JSON/);
    expect(errors).toMatch(/expected must be a non-empty array/);
    expect(errors).toMatch(/endLine < startLine/);
    expect(errors).toMatch(/lang must be/);
    expect(errors).toMatch(/no Cyrillic/);
    expect(errors).toMatch(/repo must be "a"/);
    expect(errors).toMatch(/duplicate id a-0/);
  });

  it("fails when expected paths or ranges do not exist in the clone", () => {
    const missingFile = q("a", 100, "en", { expected: [{ path: "src/nope.txt", startLine: 1, endLine: 2 }] });
    const beyondEnd = q("a", 101, "en", { expected: [{ path: "src/main.txt", startLine: 2, endLine: 9 }] });
    const errors = validateDataset({ repos, datasets: { ...good, a: good.a + missingFile + "\n" + beyondEnd + "\n" }, reposDir, ...small }).errors;
    expect(errors.some((e) => /src\/nope\.txt does not exist/.test(e))).toBe(true);
    expect(errors.some((e) => /has 4 lines, expected range ends at 9/.test(e))).toBe(true);
  });

  it("validates repo entries", () => {
    const badRepos = [{ ...repos[0], commit: "main" }, { ...repos[1], license: "" }, repos[2]];
    const errors = validateDataset({ repos: badRepos, datasets: good, ...small }).errors.join("\n");
    expect(errors).toMatch(/commit must be a full 40-char sha/);
    expect(errors).toMatch(/license is required/);
  });
});

describe("context field", () => {
  const ctx = (extra: object = {}) => ({ context: { path: "src/main.txt", line: 2, expected: [{ path: "src/main.txt", symbol: "main" }], ...extra } });
  const withExtra = (extra: object) => ({ ...good, a: good.a + q("a", 50, "en", extra) + "\n" });
  const errorsFor = (extra: object) => validateDataset({ repos, datasets: withExtra(extra), reposDir, ...small }).errors.join("\n");

  it("is optional: records without it stay valid, records with it are accepted", () => {
    expect(validateDataset({ repos, datasets: good, reposDir, ...small }).errors).toEqual([]);
    expect(errorsFor(ctx())).toBe("");
  });

  it("requires path+symbol pairs without line numbers", () => {
    expect(errorsFor(ctx({ expected: [] }))).toMatch(/context.expected must be a non-empty array/);
    expect(errorsFor(ctx({ expected: [{ path: "src/main.txt" }] }))).toMatch(/must be \{path, symbol\}/);
    expect(errorsFor(ctx({ expected: [{ path: "src/main.txt", symbol: "main", startLine: 1 }] }))).toMatch(/only path and symbol/);
    expect(errorsFor(ctx({ line: 0 }))).toMatch(/context must be/);
  });

  it("checks the input path and line against the clone", () => {
    expect(errorsFor(ctx({ line: 99 }))).toMatch(/has 4 lines/);
    expect(errorsFor(ctx({ path: "src/none.txt" }))).toMatch(/does not exist/);
  });

  it("is set on 10 records of commander and requests and nowhere else", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "datasets");
    const count = (name: string) =>
      readFileSync(path.join(dir, `${name}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .filter((l) => (JSON.parse(l) as { context?: unknown }).context !== undefined).length;
    expect(count("commander")).toBe(10);
    expect(count("requests")).toBe(10);
    expect(count("cobra")).toBe(0);
  });
});
