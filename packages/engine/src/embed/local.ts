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

const BATCH_SIZE = 16;

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

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModel.from_pretrained>>;

export function createLocalEmbedder(entry: ModelEntry, opts: LocalEmbedderOptions): Embedder {
  const dims = opts.dims ?? entry.dims;
  if (dims !== entry.dims && !entry.mrlDims?.includes(dims)) {
    throw new Error(
      `model "${entry.id}" does not support dims=${dims} (supported: ${[entry.dims, ...(entry.mrlDims ?? [])].join(", ")})`,
    );
  }
  const info: EmbedderInfo = {
    provider: "local",
    model: entry.id,
    dims,
    modelId: modelIdOf("local", entry.id, dims),
    remote: false,
    maxInputTokens: entry.maxTokens,
    batchSize: BATCH_SIZE,
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
      session_options: { intraOpNumThreads: opts.threads, interOpNumThreads: 1 },
    });
  }

  function ensureInit(signal?: AbortSignal): Promise<void> {
    initPromise ??= load(signal).catch((err) => {
      initPromise = undefined;
      throw err;
    });
    return initPromise;
  }

  async function run(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    await ensureInit(signal);
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = texts.slice(i, i + BATCH_SIZE);
      let vecs: Float32Array[];
      if (staticModel) {
        vecs = staticModel.embed(batch);
      } else {
        const inputs = tokenizer!(batch, { padding: true, truncation: true, max_length: entry.maxTokens });
        const outputs = (await model!(inputs)) as unknown as Record<string, TensorLike>;
        const pooled = outputs["sentence_embedding"];
        vecs = pooled
          ? rows(pooled)
          : pool(entry.pooling, outputs["last_hidden_state"]!, inputs.attention_mask as unknown as TensorLike);
      }
      for (const v of vecs) out.push(truncate(v, dims));
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
