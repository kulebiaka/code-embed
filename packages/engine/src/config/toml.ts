import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "smol-toml";
import { log } from "../util/log";

type Table = Record<string, unknown>;

export function readToml(path: string): Table {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    return parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid TOML: ${(e as Error).message}`);
  }
}

export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

type Kind = "string" | "number" | "boolean" | "string[]";
export interface Schema {
  [key: string]: Kind | Schema;
}

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOk(v: unknown, kind: Kind): boolean {
  if (kind === "string[]") return Array.isArray(v) && v.every((x) => typeof x === "string");
  if (kind === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === kind;
}

export function validate(
  data: Table,
  schema: Schema,
  path: string,
  forbidden: Record<string, string> = {},
  prefix = "",
): Table {
  const out: Table = {};
  for (const [key, value] of Object.entries(data)) {
    const full = prefix + key;
    const why = forbidden[full];
    if (why) throw new Error(`${path}: key "${full}" is not allowed: ${why}`);
    const rule = schema[key];
    if (rule === undefined) {
      log.warn(`${path}: unknown key "${full}"`);
      continue;
    }
    if (typeof rule === "string") {
      if (!typeOk(value, rule)) throw new Error(`${path}: key "${full}" must be ${rule}`);
      out[key] = value;
    } else {
      if (!isTable(value)) throw new Error(`${path}: key "${full}" must be a table`);
      out[key] = validate(value, rule, path, forbidden, `${full}.`);
    }
  }
  return out;
}

export function oneOf(v: unknown, allowed: readonly string[], key: string, path: string): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    throw new Error(`${path}: key "${key}" must be one of ${allowed.join(", ")}`);
  }
}
