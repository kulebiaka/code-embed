import { join } from "node:path";
import { stringify } from "smol-toml";
import type { ProviderConfig } from "@code-embed/protocol";
import { configDir } from "../core/paths";
import { PROJECT_SCHEMA, checkEnums } from "./project";
import type { UserConfig } from "./types";
import { oneOf, readToml, validate, writeFileAtomic, type Schema } from "./toml";

const USER_SCHEMA: Schema = {
  ...PROJECT_SCHEMA,
  index: { location: "string", max_file_kb: "number", threads: "number", pause_on_battery: "boolean" },
};

const PROVIDER_SCHEMA: Schema = {
  kind: "string",
  base_url: "string",
  model: "string",
  query_prefix: "string",
  doc_prefix: "string",
  max_input_tokens: "number",
  batch_size: "number",
  concurrency: "number",
  dimensions: "number",
  api_key_env: "string",
  rpm: "number",
  tpm: "number",
};

const userFile = (name: string) => join(configDir(), name);

export function loadUserConfig(): UserConfig {
  const path = userFile("config.toml");
  const cfg = validate(readToml(path), USER_SCHEMA, path) as UserConfig;
  checkEnums(cfg, path);
  return cfg;
}

function checkProvider(name: string, raw: Record<string, unknown>, path: string): ProviderConfig {
  const cfg = validate(raw, PROVIDER_SCHEMA, path, {
    api_key: "keys are not stored in config files, use api_key_env",
  }) as unknown as ProviderConfig;
  oneOf(cfg.kind, ["openai"], `${name}.kind`, path);
  for (const f of ["kind", "base_url", "model"] as const) {
    if (!cfg[f]) throw new Error(`${path}: provider "${name}" is missing "${f}"`);
  }
  return cfg;
}

export function loadProviders(): Record<string, ProviderConfig> {
  const path = userFile("providers.toml");
  const out: Record<string, ProviderConfig> = {};
  for (const [name, raw] of Object.entries(readToml(path))) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${path}: provider "${name}" must be a table`);
    }
    out[name] = checkProvider(name, raw as Record<string, unknown>, path);
  }
  return out;
}

export function saveProvider(name: string, cfg: ProviderConfig): void {
  const path = userFile("providers.toml");
  const clean = checkProvider(name, { ...cfg }, path);
  writeFileAtomic(path, stringify({ ...loadProviders(), [name]: clean }));
}
