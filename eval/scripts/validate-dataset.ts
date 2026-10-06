import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalQuery, EvalRepo } from "../src/types";

export interface ValidateInput {
  repos: unknown;
  datasets: Record<string, string>;
  reposDir?: string;
  minRepos?: number;
  maxRepos?: number;
  minPerRepo?: number;
  minRuShare?: number;
}

export interface ValidateResult {
  errors: string[];
  stats: Record<string, { count: number; ru: number; checkedAgainstClone: boolean }>;
}

const CYRILLIC = /[Ѐ-ӿ]/;
const SHA = /^[0-9a-f]{40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function validateRepos(raw: unknown, min: number, max: number, errors: string[]): EvalRepo[] {
  if (!Array.isArray(raw)) {
    errors.push("repos.json: expected an array");
    return [];
  }
  if (raw.length < min || raw.length > max) errors.push(`repos.json: expected ${min}-${max} repositories, got ${raw.length}`);
  const repos: EvalRepo[] = [];
  const names = new Set<string>();
  raw.forEach((r, i) => {
    const where = `repos.json[${i}]`;
    if (!isRecord(r)) return void errors.push(`${where}: not an object`);
    const { name, url, commit, languages, license } = r;
    if (!nonEmpty(name) || !/^[A-Za-z0-9._-]+$/.test(name)) return void errors.push(`${where}: invalid name`);
    if (names.has(name)) errors.push(`${where}: duplicate name ${name}`);
    names.add(name);
    if (!nonEmpty(url) || !/^https:\/\//.test(url)) errors.push(`${where}: url must be https`);
    if (typeof commit !== "string" || !SHA.test(commit)) errors.push(`${where}: commit must be a full 40-char sha`);
    if (!Array.isArray(languages) || languages.length === 0 || !languages.every(nonEmpty)) errors.push(`${where}: languages must be a non-empty string array`);
    if (!nonEmpty(license)) errors.push(`${where}: license is required`);
    repos.push(r as unknown as EvalRepo);
  });
  const langs = new Set(repos.flatMap((r) => (Array.isArray(r.languages) ? r.languages : [])));
  if (repos.length >= min && langs.size < min) errors.push(`repos.json: repositories must cover at least ${min} different languages`);
  return repos;
}

function validateQuery(q: unknown, where: string, repo: string, errors: string[]): EvalQuery | undefined {
  if (!isRecord(q)) {
    errors.push(`${where}: not an object`);
    return undefined;
  }
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    errors.push(`${where}: ${msg}`);
  };
  if (!nonEmpty(q.id)) fail("id is required");
  if (q.repo !== repo) fail(`repo must be "${repo}"`);
  if (!nonEmpty(q.query)) fail("query is required");
  if (q.lang !== "ru" && q.lang !== "en") fail('lang must be "ru" or "en"');
  else if (nonEmpty(q.query)) {
    const cyr = CYRILLIC.test(q.query);
    if (q.lang === "ru" && !cyr) fail("lang is ru but the query has no Cyrillic letters");
    if (q.lang === "en" && cyr) fail("lang is en but the query contains Cyrillic letters");
  }
  if (q.tags !== undefined && !(Array.isArray(q.tags) && q.tags.every(nonEmpty))) fail("tags must be a string array");
  if (!Array.isArray(q.expected) || q.expected.length === 0) fail("expected must be a non-empty array");
  else {
    q.expected.forEach((e: unknown, j: number) => {
      if (!isRecord(e) || !nonEmpty(e.path) || !isLine(e.startLine) || !isLine(e.endLine)) return fail(`expected[${j}] must be {path, startLine>=1, endLine}`);
      if (e.endLine < e.startLine) fail(`expected[${j}] endLine < startLine`);
      if (path.isAbsolute(e.path) || e.path.split("/").includes("..")) fail(`expected[${j}] path must be relative to the repo root`);
    });
  }
  return ok ? (q as unknown as EvalQuery) : undefined;
}

function countLines(file: string): number {
  const text = readFileSync(file, "utf8");
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export function validateDataset(input: ValidateInput): ValidateResult {
  const { minRepos = 3, maxRepos = 5, minPerRepo = 50, minRuShare = 1 / 3 } = input;
  const errors: string[] = [];
  const stats: ValidateResult["stats"] = {};
  const repos = validateRepos(input.repos, minRepos, maxRepos, errors);

  for (const repo of repos) {
    const raw = input.datasets[repo.name];
    if (raw === undefined) {
      errors.push(`datasets/${repo.name}.jsonl: missing`);
      continue;
    }
    const cloneDir = input.reposDir ? path.join(input.reposDir, repo.name) : undefined;
    const cloned = cloneDir !== undefined && existsSync(cloneDir);
    const ids = new Set<string>();
    const queries = new Set<string>();
    const lineCounts = new Map<string, number | null>();
    let count = 0;
    let ru = 0;

    raw.split("\n").forEach((line, i) => {
      if (line.trim() === "") return;
      const where = `${repo.name}.jsonl:${i + 1}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        errors.push(`${where}: invalid JSON`);
        return;
      }
      count++;
      const q = validateQuery(parsed, where, repo.name, errors);
      if (isRecord(parsed) && parsed.lang === "ru") ru++;
      if (!q) return;
      if (ids.has(q.id)) errors.push(`${where}: duplicate id ${q.id}`);
      ids.add(q.id);
      if (queries.has(q.query)) errors.push(`${where}: duplicate query text`);
      queries.add(q.query);
      if (!cloned) return;
      for (const e of q.expected) {
        let total = lineCounts.get(e.path);
        if (total === undefined) {
          const file = path.join(cloneDir, e.path);
          total = existsSync(file) ? countLines(file) : null;
          lineCounts.set(e.path, total);
        }
        if (total === null) errors.push(`${where}: ${e.path} does not exist in ${repo.name}`);
        else if (e.endLine > total) errors.push(`${where}: ${e.path} has ${total} lines, expected range ends at ${e.endLine}`);
      }
    });

    stats[repo.name] = { count, ru, checkedAgainstClone: cloned };
    if (count < minPerRepo) errors.push(`${repo.name}: ${count} queries, need at least ${minPerRepo}`);
    if (count > 0 && ru / count < minRuShare) errors.push(`${repo.name}: Russian share ${ru}/${count} is below ${(minRuShare * 100).toFixed(1)}%`);
  }
  return { errors, stats };
}

function main(): void {
  const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repos = JSON.parse(readFileSync(path.join(evalDir, "repos.json"), "utf8")) as unknown;
  const datasets: Record<string, string> = {};
  if (Array.isArray(repos)) {
    for (const r of repos) {
      const file = path.join(evalDir, "datasets", `${isRecord(r) ? String(r.name) : ""}.jsonl`);
      if (existsSync(file)) datasets[String((r as { name: unknown }).name)] = readFileSync(file, "utf8");
    }
  }
  const { errors, stats } = validateDataset({ repos, datasets, reposDir: path.join(evalDir, ".repos") });
  for (const [name, s] of Object.entries(stats)) {
    console.error(`${name}: ${s.count} queries, ${s.ru} ru, ${s.checkedAgainstClone ? "ranges checked against clone" : "clone not found, ranges not checked"}`);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  console.error("dataset ok");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
