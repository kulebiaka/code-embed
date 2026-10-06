import { modelIdOf } from "./model-id";
import type { Embedder, EmbedderInfo } from "./types";

export interface FakeEmbedderOptions {
  dims?: number;
  model?: string;
  latencyMs?: number;
  failWith?: Error;
}

export const FAKE_PROVIDER = "fake";

function words(text: string): string[] {
  const out: string[] = [];
  for (const token of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const parts = token
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
      .split(" ");
    for (const p of parts) out.push(p.toLowerCase());
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  private readonly latencyMs: number;
  private readonly failWith: Error | undefined;

  constructor(opts: FakeEmbedderOptions = {}) {
    const dims = opts.dims ?? 64;
    const model = opts.model ?? "fake";
    this.latencyMs = opts.latencyMs ?? 0;
    this.failWith = opts.failWith;
    this.info = {
      provider: FAKE_PROVIDER,
      model,
      dims,
      modelId: modelIdOf(FAKE_PROVIDER, model, dims),
      remote: false,
      maxInputTokens: 8192,
      batchSize: 32,
    };
  }

  async init(signal?: AbortSignal): Promise<void> {
    await this.delay(signal);
  }

  embedQueries(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.embed(texts, signal);
  }

  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.embed(texts, signal);
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async dispose(): Promise<void> {}

  embedSync(text: string): Float32Array {
    const v = new Float32Array(this.info.dims);
    for (const w of words(text)) {
      const h = fnv1a(w);
      v[h % v.length]! += h & 0x80000000 ? -1 : 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    if (norm === 0) {
      v[0] = 1;
      return v;
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }

  private async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    await this.delay(signal);
    return texts.map((t) => this.embedSync(t));
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.latencyMs > 0) await sleep(this.latencyMs, signal);
    if (this.failWith) throw this.failWith;
  }
}
