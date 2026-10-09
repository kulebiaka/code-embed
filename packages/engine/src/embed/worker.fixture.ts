import { appendFileSync } from "node:fs";
import { getPriority } from "node:os";
import { ProviderUnavailableError } from "../errors";
import type { Embedder } from "./types";
import { runEmbedWorker } from "./worker-child";

export const FIXTURE_DIMS = 8;

export function fakeVector(text: string): Float32Array {
  const v = new Float32Array(FIXTURE_DIMS);
  for (let i = 0; i < text.length; i++) v[i % FIXTURE_DIMS]! += text.charCodeAt(i) % 31;
  v[0]! += 1;
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

function embed(texts: string[]): Float32Array[] {
  const busy = Number(process.env.FIXTURE_BUSY_MS) || 0;
  if (busy > 0) {
    const end = Date.now() + busy;
    while (Date.now() < end);
  }
  return texts.map((t) => {
    if (t === "__crash__") {
      if (process.platform === "win32") process.abort();
      process.kill(process.pid, "SIGTRAP");
    }
    if (t === "__priority__") {
      const v = new Float32Array(FIXTURE_DIMS);
      v[0] = getPriority();
      return v;
    }
    return fakeVector(t);
  });
}

if (process.env.FIXTURE_SPAWN_LOG) appendFileSync(process.env.FIXTURE_SPAWN_LOG, `${process.pid}\n`);

const fake: Embedder = {
  info: {
    provider: "local",
    model: "fixture",
    dims: FIXTURE_DIMS,
    modelId: "fixture",
    remote: false,
    maxInputTokens: 512,
    batchSize: 8,
  },
  async init() {
    if (process.env.FIXTURE_INIT_FAIL === "provider") throw new ProviderUnavailableError("fixture unavailable", 1234);
    if (process.env.FIXTURE_INIT_FAIL === "error") throw new Error("fixture init failed");
  },
  embedQueries: async (texts) => embed(texts),
  embedDocuments: async (texts) => embed(texts),
  countTokens: (t) => Math.ceil(t.length / 4),
  dispose: async () => {},
};

void runEmbedWorker(() => fake).then(() => process.exit(0));
