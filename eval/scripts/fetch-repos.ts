import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRepo } from "../src/types";

const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

export function fetchRepo(repo: EvalRepo, reposDir: string): void {
  const dir = path.join(reposDir, repo.name);
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", repo.url);
  }
  let head = "";
  try {
    head = git(dir, "rev-parse", "--verify", "-q", "HEAD");
  } catch {}
  if (head === repo.commit) {
    console.error(`${repo.name}: up to date at ${repo.commit}`);
    return;
  }
  git(dir, "fetch", "-q", "--depth", "1", "origin", repo.commit);
  git(dir, "checkout", "-q", "--force", "FETCH_HEAD");
  console.error(`${repo.name}: checked out ${repo.commit}`);
}

function main(): void {
  const repos = JSON.parse(readFileSync(path.join(evalDir, "repos.json"), "utf8")) as EvalRepo[];
  const reposDir = path.join(evalDir, ".repos");
  mkdirSync(reposDir, { recursive: true });
  for (const repo of repos) fetchRepo(repo, reposDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
