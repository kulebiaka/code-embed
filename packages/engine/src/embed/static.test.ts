import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "./catalog";

vi.mock("@huggingface/transformers", () => ({
  PreTrainedTokenizer: class {
    constructor(readonly json: { vocab: Record<string, number> }) {}
    encode(text: string) {
      return text.split(" ").filter(Boolean).map((w) => this.json.vocab[w] ?? 99);
    }
  },
}));

import { loadStaticModel, parseSafetensorsMatrix } from "./static";

function safetensors(rows: number, cols: number, values: number[]): Buffer {
  const header = Buffer.from(
    JSON.stringify({ embeddings: { dtype: "F32", shape: [rows, cols], data_offsets: [0, values.length * 4] } }),
  );
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  const body = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => body.writeFloatLE(v, i * 4));
  return Buffer.concat([len, header, body]);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "static-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("static model", () => {
  it("parses a safetensors matrix", () => {
    const m = parseSafetensorsMatrix(safetensors(2, 2, [1, 2, 3, 4]));
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(2);
    expect(Array.from(m.data)).toEqual([1, 2, 3, 4]);
  });

  it("rejects unsupported dtypes", () => {
    const buf = safetensors(1, 1, [1]);
    const patched = Buffer.from(buf.toString("latin1").replace("F32", "I8_"), "latin1");
    expect(() => parseSafetensorsMatrix(patched)).toThrow(/unsupported dtype/);
  });

  it("mean-pools rows of the selected token ids", async () => {
    await writeFile(join(dir, "model.safetensors"), safetensors(3, 2, [1, 0, 0, 1, 5, 5]));
    await writeFile(join(dir, "tokenizer.json"), JSON.stringify({ vocab: { a: 0, b: 1, c: 2 } }));
    const model = await loadStaticModel(dir, getModel("potion-code-16m"));
    expect(model.dims).toBe(2);
    expect(model.countTokens("a b c")).toBe(3);
    const [v] = model.embed(["a b"]);
    expect(Array.from(v!)).toEqual([0.5, 0.5]);
    const [oov] = model.embed(["zzz"]);
    expect(Array.from(oov!)).toEqual([0, 0]);
  });
});
