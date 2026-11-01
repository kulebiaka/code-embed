import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TASK_CATEGORIES, readTasks } from "./tasks";

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const tasksFile = path.join(agentDir, "tasks.jsonl");
const reposDir = path.join(agentDir, "..", ".repos");

const isPath = (s: string) => s.includes("/");

describe("tasks.jsonl", () => {
  const tasks = readTasks(tasksFile);

  it("has 15-20 tasks with unique ids", () => {
    expect(tasks.length).toBeGreaterThanOrEqual(15);
    expect(tasks.length).toBeLessThanOrEqual(20);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  it("covers commander and requests", () => {
    const repos = new Set(tasks.map((t) => t.repo));
    expect(repos).toEqual(new Set(["commander", "requests"]));
  });

  it("uses every category", () => {
    expect(new Set(tasks.map((t) => t.category))).toEqual(new Set(TASK_CATEGORIES));
  });

  it("has a non-empty mustMention with at least one path per task", () => {
    for (const t of tasks) {
      expect(t.mustMention.length, t.id).toBeGreaterThan(0);
      expect(t.mustMention.some(isPath), t.id).toBe(true);
    }
  });

  it.skipIf(!["commander", "requests"].every((r) => existsSync(path.join(reposDir, r))))(
    "mustMention paths exist and symbols occur in the mentioned files",
    () => {
      for (const t of tasks) {
        const root = path.join(reposDir, t.repo);
        const files = t.mustMention.filter(isPath);
        for (const f of files) expect(existsSync(path.join(root, f)), `${t.id}: ${f}`).toBe(true);
        const text = files.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");
        for (const s of t.mustMention.filter((m) => !isPath(m))) expect(text, `${t.id}: ${s}`).toContain(s);
      }
    },
  );
});

describe("readTasks validation", () => {
  const withFile = (content: string, fn: (file: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-tasks-"));
    try {
      const file = path.join(dir, "t.jsonl");
      writeFileSync(file, content);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ok = { id: "a", repo: "r", question: "q", category: "impact", mustMention: ["x"] };

  it("reads a valid file and skips blank lines", () => {
    withFile(`${JSON.stringify(ok)}\n\n`, (f) => expect(readTasks(f)).toEqual([ok]));
  });

  it("rejects an unknown category", () => {
    withFile(JSON.stringify({ ...ok, category: "other" }), (f) => expect(() => readTasks(f)).toThrow(/category/));
  });

  it("rejects an empty mustMention", () => {
    withFile(JSON.stringify({ ...ok, mustMention: [] }), (f) => expect(() => readTasks(f)).toThrow(/mustMention/));
  });

  it("rejects a missing field and invalid JSON", () => {
    withFile(JSON.stringify({ ...ok, question: undefined }), (f) => expect(() => readTasks(f)).toThrow(/question/));
    withFile("{oops", (f) => expect(() => readTasks(f)).toThrow(/invalid JSON/));
  });
});
