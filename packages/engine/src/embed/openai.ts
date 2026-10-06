import type { ProviderConfig } from "@code-embed/protocol";
import { ProviderUnavailableError } from "../errors";
import { log } from "../util/log";
import { modelIdOf } from "./model-id";
import { abortableSleep, RateLimiter } from "./ratelimit";
import type { Embedder, EmbedderInfo } from "./types";

export interface OpenAIEmbedderOptions {
  name: string;
  config: ProviderConfig;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function normalize(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
}

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const { name, config, apiKey } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = Math.max(1, config.batch_size ?? 32);
  const concurrency = Math.max(1, config.concurrency ?? 4);
  const url = `${config.base_url.replace(/\/+$/, "")}/embeddings`;
  const parsed = new URL(config.base_url);
  const limiter = new RateLimiter({ rpm: config.rpm, tpm: config.tpm });

  const info: EmbedderInfo = {
    provider: name,
    model: config.model,
    dims: config.dimensions ?? 0,
    modelId: config.dimensions ? modelIdOf(name, config.model, config.dimensions) : "",
    remote: !isLoopback(parsed.hostname),
    host: parsed.hostname,
    maxInputTokens: config.max_input_tokens ?? 8192,
    batchSize,
  };

  const redact = (s: string): string => (apiKey ? s.split(apiKey).join("***") : s);

  async function requestOnce(input: string[], signal?: AbortSignal): Promise<Response> {
    const body: Record<string, unknown> = {
      model: config.model,
      input,
      encoding_format: "float",
    };
    if (config.dimensions) body.dimensions = config.dimensions;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      const reason = timeout.aborted
        ? `timed out after ${timeoutMs} ms`
        : redact(e instanceof Error ? e.message : String(e));
      throw new ProviderUnavailableError(`provider "${name}" (${parsed.host}) request failed: ${reason}`);
    }
  }

  async function embedBatch(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const tokens = input.reduce((n, t) => n + estimateTokens(t), 0);
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire(tokens, signal);
      const res = await requestOnce(input, signal);
      if (res.ok) return parseVectors(await res.json().catch(() => ({})), input.length);

      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        const text = redact((await res.text().catch(() => "")).slice(0, 200));
        throw new ProviderUnavailableError(
          `provider "${name}" (${parsed.host}) responded ${res.status}${text ? `: ${text}` : ""}`,
          retryAfterMs,
        );
      }
      await res.body?.cancel().catch(() => undefined);
      const delay = Math.min(MAX_DELAY_MS, retryAfterMs ?? BASE_DELAY_MS * 2 ** attempt);
      log.debug(`provider "${name}" responded ${res.status}, retry ${attempt + 1} in ${delay} ms`);
      await abortableSleep(delay, signal);
    }
  }

  function parseVectors(json: unknown, expected: number): Float32Array[] {
    const data = (json as EmbeddingsResponse).data;
    if (!Array.isArray(data) || data.length !== expected) {
      throw new ProviderUnavailableError(`provider "${name}" returned a malformed embeddings response`);
    }
    const sorted = data
      .map((d, i) => ({ index: d.index ?? i, embedding: d.embedding }))
      .sort((a, b) => a.index - b.index);
    return sorted.map((d) => {
      if (!Array.isArray(d.embedding) || d.embedding.length === 0) {
        throw new ProviderUnavailableError(`provider "${name}" returned a malformed embedding`);
      }
      if (info.dims && d.embedding.length !== info.dims) {
        throw new ProviderUnavailableError(
          `provider "${name}" returned ${d.embedding.length}-dim vectors, expected ${info.dims}`,
        );
      }
      return normalize(d.embedding);
    });
  }

  async function embedAll(texts: string[], prefix: string, signal?: AbortSignal): Promise<Float32Array[]> {
    const inputs = prefix ? texts.map((t) => prefix + t) : texts;
    const batches: string[][] = [];
    for (let i = 0; i < inputs.length; i += batchSize) batches.push(inputs.slice(i, i + batchSize));
    const results: Float32Array[][] = new Array(batches.length);
    let next = 0;
    const ctl = new AbortController();
    const inner = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const i = next++;
        results[i] = await embedBatch(batches[i]!, inner);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    } catch (e) {
      ctl.abort(e);
      throw e;
    }
    return results.flat();
  }

  return {
    info,
    async init(signal) {
      if (info.dims > 0) return;
      const [v] = await embedBatch(["dimension probe"], signal);
      info.dims = v!.length;
      info.modelId = modelIdOf(name, config.model, info.dims);
    },
    embedQueries: (texts, signal) => embedAll(texts, config.query_prefix ?? "", signal),
    embedDocuments: (texts, signal) => embedAll(texts, config.doc_prefix ?? "", signal),
    countTokens: estimateTokens,
    async dispose() {},
  };
}
