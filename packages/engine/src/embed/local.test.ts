import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "./catalog";

const state = vi.hoisted(() => ({
  fromPretrainedOpts: undefined as any,
  modelName: undefined as string | undefined,
  tokenized: [] as string[][],
  tokCalls: [] as { texts: string[]; opts: any }[],
  lengthOf: ((_t: string) => 1) as (t: string) => number,
  outputFn: undefined as undefined | ((texts: string[]) => Record<string, { data: number[]; dims: number[] }>),
  output: {} as Record<string, { data: number[]; dims: number[] }>,
  mask: { data: [] as number[], dims: [] as number[] },
  env: { localModelPath: "", allowRemoteModels: true, allowLocalModels: false } as any,
  ensure: vi.fn(async (_e: unknown, o: { modelsDir: string }) => `${o.modelsDir}/x`),
}));

vi.mock("./delivery", () => ({ ensureModel: state.ensure }));
vi.mock("@huggingface/transformers", () => ({
  env: state.env,
  PreTrainedTokenizer: class {},
  AutoTokenizer: {
    from_pretrained: async () => {
      const tok: any = (texts: string[], o: any) => {
        state.tokCalls.push({ texts, opts: o });
        if (o?.padding) state.tokenized.push(texts);
        return { input_ids: { dims: [texts.length, state.lengthOf(texts[0]!)] }, attention_mask: state.mask };
      };
      tok.encode = (t: string) => t.split(" ");
      return tok;
    },
  },
  AutoModel: {
    from_pretrained: async (name: string, opts: unknown) => {
      state.modelName = name;
      state.fromPretrainedOpts = opts;
      return async () => (state.outputFn ? state.outputFn(state.tokenized.at(-1)!) : state.output);
    },
  },
}));

import {
  BATCH_ATTENTION_BUDGET,
  BATCH_TOKEN_BUDGET,
  LOCAL_MAX_INPUT_TOKENS,
  MAX_SUB_BATCH,
  createLocalEmbedder,
  formatDocument,
  formatQuery,
} from "./local";

const opts = { modelsDir: "/m", threads: 3 };

beforeEach(() => {
  state.tokenized = [];
  state.tokCalls = [];
  state.lengthOf = () => 1;
  state.outputFn = undefined;
  state.ensure.mockClear();
});

describe("formatting", () => {
  it("qwen3 uses English instruction for queries only", () => {
    const e = getModel("qwen3-embedding-0.6b");
    expect(formatQuery(e, "найти парсер")).toBe(
      "Instruct: Given a question, retrieve code that answers it\nQuery: найти парсер",
    );
    expect(formatDocument(e, "code")).toBe("code");
  });

  it("other models use manifest prefixes", () => {
    const e5 = getModel("multilingual-e5-small");
    expect(formatQuery(e5, "q")).toBe("query: q");
    expect(formatDocument(e5, "d")).toBe("passage: d");
    expect(formatQuery(getModel("bge-m3"), "q")).toBe("q");
  });
});

describe("local embedder", () => {
  it("init ensures the model, configures local-only loading and threads", async () => {
    const emb = createLocalEmbedder(getModel("multilingual-e5-small"), opts);
    await emb.init();
    expect(state.ensure).toHaveBeenCalledTimes(1);
    expect(state.env.localModelPath).toBe("/m");
    expect(state.env.allowRemoteModels).toBe(false);
    expect(state.modelName).toBe("multilingual-e5-small");
    expect(state.fromPretrainedOpts.session_options).toEqual({
      intraOpNumThreads: 3,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false,
      extra: { session: { disable_prepacking: "1" } },
    });
    expect(state.fromPretrainedOpts.dtype).toBe("q8");
    expect(emb.info.modelId).toBe("local/multilingual-e5-small@384");
    expect(emb.info.maxInputTokens).toBe(512);
  });

  it("loads plain model.onnx as fp32", async () => {
    await createLocalEmbedder(getModel("coderankembed-137m"), opts).init();
    expect(state.fromPretrainedOpts.dtype).toBe("fp32");
  });

  it("mean pooling respects the mask and normalizes", async () => {
    state.output = { last_hidden_state: { data: [3, 0, 1, 0, 9, 9], dims: [1, 3, 2] } };
    state.mask = { data: [1, 1, 0], dims: [1, 3] };
    const emb = createLocalEmbedder({ ...getModel("multilingual-e5-small"), dims: 2 }, opts);
    const [v] = await emb.embedDocuments(["a b"]);
    expect(state.tokenized[0]).toEqual(["passage: a b"]);
    expect(v![0]).toBeCloseTo(1);
    expect(v![1]).toBeCloseTo(0);
  });

  it("cls pooling takes the first token", async () => {
    state.output = { last_hidden_state: { data: [0, 4, 7, 7], dims: [1, 2, 2] } };
    state.mask = { data: [1, 1], dims: [1, 2] };
    const emb = createLocalEmbedder({ ...getModel("bge-m3"), dims: 2 }, opts);
    const [v] = await emb.embedQueries(["q"]);
    expect(Array.from(v!)).toEqual([0, 1]);
  });

  it("last_token pooling handles left and right padding", async () => {
    state.output = { last_hidden_state: { data: [1, 0, 0, 2, 5, 5, 9, 9, 0, 3, 0, 4], dims: [2, 3, 2] } };
    state.mask = { data: [1, 1, 0, 0, 1, 1], dims: [2, 3] };
    const emb = createLocalEmbedder({ ...getModel("qwen3-embedding-0.6b"), dims: 2, mrlDims: undefined }, opts);
    const [a, b] = await emb.embedDocuments(["x", "y"]);
    expect(a![1]).toBeCloseTo(1);
    expect(b![1]).toBeCloseTo(1);
  });

  it("MRL truncation renormalizes", async () => {
    const hidden = new Array(1024).fill(0);
    hidden[0] = 3;
    hidden[1] = 4;
    hidden[900] = 100;
    state.output = { last_hidden_state: { data: hidden, dims: [1, 1, 1024] } };
    state.mask = { data: [1], dims: [1, 1] };
    const emb = createLocalEmbedder(getModel("qwen3-embedding-0.6b"), { ...opts, dims: 256 });
    expect(emb.info.dims).toBe(256);
    expect(emb.info.modelId).toBe("local/qwen3-embedding-0.6b@256");
    const [v] = await emb.embedDocuments(["x"]);
    expect(v!.length).toBe(256);
    expect(v![0]).toBeCloseTo(0.6);
    expect(v![1]).toBeCloseTo(0.8);
  });

  it("rejects unsupported dims", () => {
    expect(() => createLocalEmbedder(getModel("bge-m3"), { ...opts, dims: 512 })).toThrow(/dims/);
  });

  it("prefers sentence_embedding output when present", async () => {
    state.output = { sentence_embedding: { data: [0, 2], dims: [1, 2] } };
    const emb = createLocalEmbedder({ ...getModel("embeddinggemma-300m"), dims: 2, mrlDims: undefined }, opts);
    const [v] = await emb.embedQueries(["q"]);
    expect(state.tokenized[0]).toEqual(["task: code retrieval | query: q"]);
    expect(Array.from(v!)).toEqual([0, 1]);
  });

  it("caps input tokens at min(entry.maxTokens, LOCAL_MAX_INPUT_TOKENS)", async () => {
    const big = createLocalEmbedder(getModel("qwen3-embedding-0.6b"), opts);
    expect(big.info.maxInputTokens).toBe(LOCAL_MAX_INPUT_TOKENS);
    expect(big.info.batchSize).toBe(MAX_SUB_BATCH);
    state.output = { sentence_embedding: { data: [1, 0], dims: [1, 2] } };
    await createLocalEmbedder({ ...getModel("qwen3-embedding-0.6b"), dims: 2, mrlDims: undefined }, opts).embedDocuments(["x"]);
    expect(state.tokCalls.length).toBeGreaterThan(0);
    for (const c of state.tokCalls) {
      expect(c.opts.truncation).toBe(true);
      expect(c.opts.max_length).toBe(LOCAL_MAX_INPUT_TOKENS);
    }
    const small = createLocalEmbedder(getModel("multilingual-e5-small"), opts);
    expect(small.info.maxInputTokens).toBe(512);
  });

  it("splits into budgeted sub-batches, long texts alone, results in input order", async () => {
    const lens = [10, 1024, 30, 500, 20, 1024, 5, 600, 40, 700, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23];
    const texts = lens.map((n, i) => `t${i}:${n}`);
    state.lengthOf = (t) => Number(t.split(":")[1]);
    state.outputFn = (batch) => ({
      sentence_embedding: { data: batch.flatMap((t) => [Number(t.split(":")[0]!.slice(1)) + 1, 0]), dims: [batch.length, 2] },
    });
    const emb = createLocalEmbedder({ ...getModel("bge-m3"), dims: 2, mrlDims: undefined, maxTokens: 8192 }, opts);
    const out = await emb.embedDocuments(texts);
    expect(out.length).toBe(texts.length);
    out.forEach((v) => expect(v[0]).toBeCloseTo(1));
    expect(state.tokenized.flat().sort()).toEqual([...texts].sort());
    for (const group of state.tokenized) {
      const l = group.map(state.lengthOf);
      const max = Math.max(...l);
      expect(group.length).toBeLessThanOrEqual(MAX_SUB_BATCH);
      expect(group.length * max).toBeLessThanOrEqual(Math.max(BATCH_TOKEN_BUDGET, max));
      expect(group.length * max * max).toBeLessThanOrEqual(Math.max(BATCH_ATTENTION_BUDGET, max * max));
    }
    expect(state.tokenized.filter((g) => g.some((t) => state.lengthOf(t) === 1024)).every((g) => g.length === 1)).toBe(true);
  });

  it("returns vectors at their original indices", async () => {
    state.lengthOf = (t) => Number(t.split(":")[1]);
    state.outputFn = (batch) => ({
      sentence_embedding: { data: batch.flatMap((t) => (t.startsWith("a") ? [1, 0] : [0, 1])), dims: [batch.length, 2] },
    });
    const emb = createLocalEmbedder({ ...getModel("bge-m3"), dims: 2, mrlDims: undefined }, opts);
    const out = await emb.embedDocuments(["a:900", "b:5", "a:3", "b:700", "a:1"]);
    expect(out.map((v) => Array.from(v))).toEqual([[1, 0], [0, 1], [1, 0], [0, 1], [1, 0]]);
  });

  it("checks the abort signal between sub-batches", async () => {
    state.lengthOf = () => 1024;
    state.outputFn = (batch) => ({ sentence_embedding: { data: batch.flatMap(() => [1, 0]), dims: [batch.length, 2] } });
    const emb = createLocalEmbedder({ ...getModel("bge-m3"), dims: 2, mrlDims: undefined }, opts);
    await emb.init();
    const ac = new AbortController();
    const orig = state.outputFn;
    state.outputFn = (b) => {
      ac.abort();
      return orig(b);
    };
    await expect(emb.embedDocuments(["a", "b", "c"], ac.signal)).rejects.toThrow();
    expect(state.tokenized.length).toBe(1);
  });

  it("countTokens uses the tokenizer", async () => {
    const emb = createLocalEmbedder(getModel("bge-m3"), opts);
    expect(() => emb.countTokens("a b c")).toThrow(/not initialized/);
    await emb.init();
    expect(emb.countTokens("a b c")).toBe(3);
  });
});

describe("unavailable ML runtime", () => {
  it("maps import failure to ProviderUnavailableError and retries the load", async () => {
    let attempts = 0;
    vi.resetModules();
    vi.doMock("@huggingface/transformers", () => {
      attempts++;
      throw new Error("dlopen failed: sharp");
    });
    const { createLocalEmbedder: create } = await import("./local");
    const { ProviderUnavailableError } = await import("../errors");
    const emb = create(getModel("bge-m3"), opts);
    await expect(emb.init()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(emb.embedQueries(["q"])).rejects.toThrow(/local ML runtime is unavailable: /);
    expect(attempts).toBe(2);
    vi.doUnmock("@huggingface/transformers");
  });
});
