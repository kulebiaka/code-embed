import type { AutoModel, AutoTokenizer } from "@huggingface/transformers";
import { ensureModel } from "./delivery";
import { modelIdOf } from "./model-id";
import { loadStaticModel, loadTransformers, type StaticModel } from "./static";
import type { Embedder, EmbedderInfo, ModelEntry } from "./types";

export interface LocalEmbedderOptions {
  modelsDir: string;
  threads: number;
  dims?: number;
  offlineArchive?: string;
  proxy?: string;
}

export const LOCAL_MAX_INPUT_TOKENS = 1024;
export const MAX_SUB_BATCH = 16;
export const BATCH_TOKEN_BUDGET = 1024;
export const BATCH_ATTENTION_BUDGET = 1_048_576;

export function formatQuery(entry: ModelEntry, query: string): string {
  return `${entry.queryInstruction ?? entry.queryPrefix ?? ""}${query}`;
}

export function formatDocument(entry: ModelEntry, text: string): string {
  return `${entry.docPrefix ?? ""}${text}`;
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

function truncate(v: Float32Array, dims: number): Float32Array {
  return normalize(v.length === dims ? v : v.slice(0, dims));
}

interface TensorLike {
  data: ArrayLike<number>;
  dims: number[];
  dispose?: () => void;
}

export function planSubBatches(lengths: number[]): number[][] {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]! || a - b);
  const groups: number[][] = [];
  let cur: number[] = [];
  for (const idx of order) {
    const count = cur.length + 1;
    const maxLen = lengths[idx]!;
    const fits =
      count <= MAX_SUB_BATCH && count * maxLen <= BATCH_TOKEN_BUDGET && count * maxLen * maxLen <= BATCH_ATTENTION_BUDGET;
    if (!fits && cur.length > 0) {
      groups.push(cur);
      cur = [];
    }
    cur.push(idx);
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

function pool(mode: ModelEntry["pooling"], hidden: TensorLike, mask: TensorLike): Float32Array[] {
  const [batch, seq, dim] = hidden.dims as [number, number, number];
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const v = new Float32Array(dim);
    const base = b * seq;
    const m = (t: number) => Number(mask.data[base + t]);
    if (mode === "cls") {
      for (let j = 0; j < dim; j++) v[j] = Number(hidden.data[base * dim + j]);
    } else if (mode === "last_token") {
      let last = seq - 1;
      while (last > 0 && m(last) === 0) last--;
      for (let j = 0; j < dim; j++) v[j] = Number(hidden.data[(base + last) * dim + j]);
    } else {
      let n = 0;
      for (let t = 0; t < seq; t++) {
        if (m(t) === 0) continue;
        n++;
        for (let j = 0; j < dim; j++) v[j]! += Number(hidden.data[(base + t) * dim + j]);
      }
      if (n > 0) for (let j = 0; j < dim; j++) v[j]! /= n;
    }
    out.push(v);
  }
  return out;
}

function rows(t: TensorLike): Float32Array[] {
  const [batch, dim] = t.dims as [number, number];
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const v = new Float32Array(dim);
    for (let j = 0; j < dim; j++) v[j] = Number(t.data[b * dim + j]);
    out.push(v);
  }
  return out;
}

interface OrtSession {
  outputNames: string[];
  run: (feed: unknown, fetches?: string[]) => Promise<unknown>;
}

// decoder-style ONNX exports also emit present.* KV tensors (~1 GB per 4k tokens for qwen3) that pooling never reads
function restrictOutputs(model: Model): void {
  const session = (model as unknown as { sessions?: Record<string, OrtSession> }).sessions?.["model"];
  if (!session) return;
  const wanted = ["sentence_embedding", "last_hidden_state"].filter((n) => session.outputNames.includes(n));
  if (wanted.length === 0) return;
  const run = session.run.bind(session);
  session.run = (feed, fetches) => run(feed, fetches ?? wanted);
}

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModel.from_pretrained>>;

export function createLocalEmbedder(entry: ModelEntry, opts: LocalEmbedderOptions): Embedder {
  const dims = opts.dims ?? entry.dims;
  if (dims !== entry.dims && !entry.mrlDims?.includes(dims)) {
    throw new Error(
      `model "${entry.id}" does not support dims=${dims} (supported: ${[entry.dims, ...(entry.mrlDims ?? [])].join(", ")})`,
    );
  }
  const maxTokens = Math.min(entry.maxTokens, LOCAL_MAX_INPUT_TOKENS);
  const info: EmbedderInfo = {
    provider: "local",
    model: entry.id,
    dims,
    modelId: modelIdOf("local", entry.id, dims),
    remote: false,
    maxInputTokens: maxTokens,
    batchSize: MAX_SUB_BATCH,
  };

  let tokenizer: Tokenizer | undefined;
  let model: Model | undefined;
  let staticModel: StaticModel | undefined;
  let initPromise: Promise<void> | undefined;

  async function load(signal?: AbortSignal): Promise<void> {
    const dir = await ensureModel(entry, {
      modelsDir: opts.modelsDir,
      offlineArchive: opts.offlineArchive,
      proxy: opts.proxy,
      signal,
    });
    if (entry.pooling === "static") {
      staticModel = await loadStaticModel(dir, entry);
      return;
    }
    const { AutoModel, AutoTokenizer, env } = await loadTransformers();
    env.localModelPath = opts.modelsDir;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    tokenizer = await AutoTokenizer.from_pretrained(entry.id);
    const plain = entry.files.some((f) => f.path.endsWith("/model.onnx"));
    model = await AutoModel.from_pretrained(entry.id, {
      dtype: plain ? "fp32" : entry.dtype,
      session_options: {
        intraOpNumThreads: opts.threads,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
        enableMemPattern: false,
        extra: { session: { disable_prepacking: "1" } },
      },
    });
    restrictOutputs(model);
  }

  function ensureInit(signal?: AbortSignal): Promise<void> {
    initPromise ??= load(signal).catch((err) => {
      initPromise = undefined;
      throw err;
    });
    return initPromise;
  }

  async function embedBatch(batch: string[]): Promise<Float32Array[]> {
    const inputs = tokenizer!(batch, { padding: true, truncation: true, max_length: maxTokens });
    const outputs = (await model!(inputs)) as unknown as Record<string, TensorLike>;
    try {
      const pooled = outputs["sentence_embedding"];
      return pooled
        ? rows(pooled)
        : pool(entry.pooling, outputs["last_hidden_state"]!, inputs.attention_mask as unknown as TensorLike);
    } finally {
      for (const t of Object.values(outputs)) t?.dispose?.();
    }
  }

  async function run(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    await ensureInit(signal);
    const out: Float32Array[] = new Array(texts.length);
    if (staticModel) {
      for (let i = 0; i < texts.length; i += MAX_SUB_BATCH) {
        signal?.throwIfAborted();
        staticModel.embed(texts.slice(i, i + MAX_SUB_BATCH)).forEach((v, j) => (out[i + j] = truncate(v, dims)));
      }
      return out;
    }
    const lengths = texts.map((t) => {
      signal?.throwIfAborted();
      const enc = tokenizer!([t], { truncation: true, max_length: maxTokens });
      return Number((enc.input_ids as unknown as TensorLike).dims.at(-1));
    });
    for (const group of planSubBatches(lengths)) {
      signal?.throwIfAborted();
      const vecs = await embedBatch(group.map((i) => texts[i]!));
      group.forEach((i, j) => (out[i] = truncate(vecs[j]!, dims)));
    }
    return out;
  }

  return {
    info,
    init: (signal) => ensureInit(signal),
    embedQueries: (texts, signal) => run(texts.map((t) => formatQuery(entry, t)), signal),
    embedDocuments: (texts, signal) => run(texts.map((t) => formatDocument(entry, t)), signal),
    countTokens(text) {
      if (staticModel) return staticModel.countTokens(text);
      if (!tokenizer) throw new Error("embedder not initialized");
      return tokenizer.encode(text).length;
    },
    async dispose() {
      await (model as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
      model = undefined;
      tokenizer = undefined;
      staticModel = undefined;
      initPromise = undefined;
    },
  };
}
