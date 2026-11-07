import { readFileSync } from "node:fs";

export const TASK_CATEGORIES = ["how-works", "impact", "callers"] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export interface AgentTask {
  id: string;
  repo: string;
  question: string;
  category: TaskCategory;
  mustMention: string[];
}

function parseTask(raw: unknown, where: string): AgentTask {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: not an object`);
  const r = raw as Record<string, unknown>;
  for (const key of ["id", "repo", "question"] as const) {
    if (typeof r[key] !== "string" || r[key] === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  if (!TASK_CATEGORIES.includes(r.category as TaskCategory)) {
    throw new Error(`${where}: "category" must be one of ${TASK_CATEGORIES.join(", ")}`);
  }
  const mm = r.mustMention;
  if (!Array.isArray(mm) || mm.length === 0 || mm.some((s) => typeof s !== "string" || s === "")) {
    throw new Error(`${where}: "mustMention" must be a non-empty list of non-empty strings`);
  }
  return r as unknown as AgentTask;
}

export function readTasks(file: string): AgentTask[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, n }) => {
      const where = `${file}:${n}`;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new Error(`${where}: invalid JSON`);
      }
      return parseTask(raw, where);
    });
}
