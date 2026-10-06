import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getModel } from "./catalog";
import { createLocalEmbedder } from "./local";

const enabled = process.env.CODE_EMBED_MODEL_TESTS === "1";
const modelId = process.env.CODE_EMBED_TEST_MODEL ?? "multilingual-e5-small";

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

describe.skipIf(!enabled)("local embedder (real model)", () => {
  it("embeds normalized vectors and ranks relevant code higher", async () => {
    const modelsDir = process.env.CODE_EMBED_CACHE_DIR
      ? join(process.env.CODE_EMBED_CACHE_DIR, "models")
      : await mkdtemp(join(tmpdir(), "code-embed-models-"));
    const emb = createLocalEmbedder(getModel(modelId), { modelsDir, threads: 2 });
    await emb.init();
    const [q] = await emb.embedQueries(["function that reads a file from disk"]);
    const [good, bad] = await emb.embedDocuments([
      "function readFile(path) { return fs.readFileSync(path, 'utf8'); }",
      "class Button extends Component { render() { return <div/>; } }",
    ]);
    expect(q!.length).toBe(emb.info.dims);
    expect(dot(q!, q!)).toBeCloseTo(1, 3);
    expect(dot(q!, good!)).toBeGreaterThan(dot(q!, bad!));
    expect(emb.countTokens("hello world")).toBeGreaterThan(0);
    await emb.dispose();
  }, 600_000);
});
