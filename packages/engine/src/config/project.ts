import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import type { ProjectConfig } from "./types";
import { oneOf, readToml, validate, writeFileAtomic, type Schema } from "./toml";

export const PROJECT_CONFIG = ".code-embed.toml";

export const PROJECT_SCHEMA: Schema = {
  exclude: "string[]",
  embedding: { provider: "string", model: "string" },
  index: { location: "string", max_file_kb: "number" },
  search: { default_mode: "string", top: "number" },
};

const FORBIDDEN: Record<string, string> = {
  base_url: "addresses are configured only in providers.toml",
  api_key: "keys never go into project files",
  api_key_env: "keys never go into project files",
  "embedding.base_url": "addresses are configured only in providers.toml",
  "embedding.api_key": "keys never go into project files",
  "embedding.api_key_env": "keys never go into project files",
};

export function checkEnums(cfg: ProjectConfig, path: string): void {
  oneOf(cfg.index?.location, ["project", "cache"], "index.location", path);
  oneOf(cfg.search?.default_mode, ["hybrid", "semantic", "lexical"], "search.default_mode", path);
}

export function loadProjectConfig(root: string): ProjectConfig {
  const path = join(root, PROJECT_CONFIG);
  const cfg = validate(readToml(path), PROJECT_SCHEMA, path, FORBIDDEN) as ProjectConfig;
  checkEnums(cfg, path);
  return cfg;
}

export function writeProjectConfig(root: string, patch: ProjectConfig): void {
  const path = join(root, PROJECT_CONFIG);
  const merged = merge({ ...loadProjectConfig(root) }, { ...patch }) as ProjectConfig;
  validate(merged as Record<string, unknown>, PROJECT_SCHEMA, path, FORBIDDEN);
  checkEnums(merged, path);
  writeFileAtomic(path, stringify(merged));
  ensureGitignored(root);
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    const bothTables =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur);
    out[k] = bothTables ? merge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

function ensureGitignored(root: string): void {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${PROJECT_CONFIG}\n`);
    return;
  }
  const text = readFileSync(path, "utf8");
  if (text.split(/\r?\n/).some((l) => l.trim() === PROJECT_CONFIG)) return;
  appendFileSync(path, `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${PROJECT_CONFIG}\n`);
}
