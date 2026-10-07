import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError } from "../errors";
import type { ModelEntry } from "./types";

export type Transformers = typeof import("@huggingface/transformers");

export async function loadTransformers(): Promise<Transformers> {
  try {
    return await import("@huggingface/transformers");
  } catch (err) {
    throw new ProviderUnavailableError(
      `local ML runtime is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface StaticModel {
  dims: number;
  countTokens(text: string): number;
  embed(texts: string[]): Float32Array[];
}

interface TensorMeta {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
}

function f16ToF32(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

export function parseSafetensorsMatrix(buf: Buffer): { rows: number; cols: number; data: Float32Array } {
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString("utf8")) as Record<string, TensorMeta>;
  const meta =
    header["embeddings"] ??
    Object.entries(header).find(([k, v]) => k !== "__metadata__" && v.shape.length === 2)?.[1];
  if (!meta || meta.shape.length !== 2) throw new Error("safetensors: no 2-D embedding matrix found");
  const [rows, cols] = meta.shape as [number, number];
  const bytes = buf.subarray(8 + headerLen + meta.data_offsets[0], 8 + headerLen + meta.data_offsets[1]);
  const count = rows * cols;
  const data = new Float32Array(count);
  if (meta.dtype === "F32") {
    for (let i = 0; i < count; i++) data[i] = bytes.readFloatLE(i * 4);
  } else if (meta.dtype === "F16") {
    for (let i = 0; i < count; i++) data[i] = f16ToF32(bytes.readUInt16LE(i * 2));
  } else {
    throw new Error(`safetensors: unsupported dtype ${meta.dtype}`);
  }
  return { rows, cols, data };
}

export async function loadStaticModel(dir: string, entry: ModelEntry): Promise<StaticModel> {
  const [weights, tokJson] = await Promise.all([
    readFile(join(dir, "model.safetensors")),
    readFile(join(dir, "tokenizer.json"), "utf8"),
  ]);
  const { rows, cols, data } = parseSafetensorsMatrix(weights);
  const { PreTrainedTokenizer } = await loadTransformers();
  const tokenizer = new PreTrainedTokenizer(JSON.parse(tokJson), {});

  const ids = (text: string): number[] =>
    tokenizer.encode(text, { add_special_tokens: false }).slice(0, entry.maxTokens);

  return {
    dims: cols,
    countTokens: (text) => ids(text).length,
    embed(texts) {
      return texts.map((text) => {
        const out = new Float32Array(cols);
        let n = 0;
        for (const id of ids(text)) {
          if (id < 0 || id >= rows) continue;
          const off = id * cols;
          for (let j = 0; j < cols; j++) out[j]! += data[off + j]!;
          n++;
        }
        if (n > 0) for (let j = 0; j < cols; j++) out[j]! /= n;
        return out;
      });
    },
  };
}
