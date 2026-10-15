import type { IndexStatus, ProviderConfig } from "@code-embed/protocol/rpc";
import type { ClientState } from "../../src/engine/types";

export const NUMBER_FIELDS = ["dimensions", "max_input_tokens", "batch_size", "concurrency", "rpm", "tpm"] as const;
export const TEXT_FIELDS = ["query_prefix", "doc_prefix", "api_key_env"] as const;

export type ProviderForm = { name: string; base_url: string; model: string } & Record<(typeof NUMBER_FIELDS)[number] | (typeof TEXT_FIELDS)[number], string>;

export type FormResult = { ok: true; name: string; config: ProviderConfig } | { ok: false; errors: Partial<Record<keyof ProviderForm, string>> };

export function validateProvider(form: ProviderForm, taken: readonly string[]): FormResult {
  const errors: Partial<Record<keyof ProviderForm, string>> = {};
  const name = form.name.trim();
  if (!name) errors.name = "Required";
  else if (!/^[A-Za-z0-9._-]+$/.test(name)) errors.name = "Use letters, digits, dot, dash or underscore";
  else if (name === "local" || taken.includes(name)) errors.name = "This name is already used";

  const baseUrl = form.base_url.trim();
  if (!baseUrl) errors.base_url = "Required";
  else if (!/^https?:\/\/[^/\s]+/.test(baseUrl)) errors.base_url = "Must be an http(s) URL, e.g. http://localhost:11434/v1";

  const model = form.model.trim();
  if (!model) errors.model = "Required";

  const config: ProviderConfig = { kind: "openai", base_url: baseUrl, model };
  for (const f of NUMBER_FIELDS) {
    const raw = form[f].trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) errors[f] = "Positive integer";
    else config[f] = n;
  }
  for (const f of TEXT_FIELDS) {
    if (form[f] !== "") config[f] = form[f];
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, name, config };
}

export function formFromConfig(name: string, c: ProviderConfig | undefined): ProviderForm {
  const s = (v: string | number | undefined) => (v === undefined ? "" : String(v));
  return {
    name,
    base_url: s(c?.base_url),
    model: s(c?.model),
    dimensions: s(c?.dimensions),
    max_input_tokens: s(c?.max_input_tokens),
    batch_size: s(c?.batch_size),
    concurrency: s(c?.concurrency),
    rpm: s(c?.rpm),
    tpm: s(c?.tpm),
    query_prefix: s(c?.query_prefix),
    doc_prefix: s(c?.doc_prefix),
    api_key_env: s(c?.api_key_env),
  };
}

export type Tone = "ok" | "busy" | "warn" | "error";

export function engineSummary(engine: ClientState | undefined, s: IndexStatus | undefined): { label: string; tone: Tone; percent?: number } {
  if (engine === "failed") return { label: "Engine failed to start", tone: "error" };
  if (engine === "stopped") return { label: "Engine stopped", tone: "error" };
  if (engine !== "ready" || !s) return { label: "Engine starting…", tone: "busy" };
  if (s.phase === "error" || s.lastError) return { label: "Indexing error", tone: "error" };
  if (s.phase === "paused") return { label: "Indexing paused", tone: "warn" };
  if (s.phase === "model-download") return { label: "Downloading model…", tone: "busy" };
  if (s.phase === "scanning") return { label: "Scanning files…", tone: "busy" };
  const percent = s.chunks > 0 ? Math.min(100, Math.floor((s.embedded / s.chunks) * 100)) : 0;
  if (s.lexicalOnly) return { label: "Ready, keyword search only", tone: "warn" };
  if (s.phase !== "idle" || (s.chunks > 0 && s.embedded < s.chunks)) return { label: `Indexing, ${percent}% embedded`, tone: "busy", percent };
  return { label: "Index up to date", tone: "ok", percent: 100 };
}

export function parseIntSetting(raw: string, min: number): number | undefined {
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isInteger(n) && n >= min ? n : undefined;
}
