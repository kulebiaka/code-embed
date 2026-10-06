import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, getModel, loadManifest } from "./catalog";

describe("catalog", () => {
  const manifest = loadManifest();

  it("lists the six catalog models and no jina-code", () => {
    expect(manifest.models.map((m) => m.id).sort()).toEqual(
      [
        "bge-m3",
        "coderankembed-137m",
        "embeddinggemma-300m",
        "multilingual-e5-small",
        "potion-code-16m",
        "qwen3-embedding-0.6b",
      ].sort(),
    );
    expect(JSON.stringify(manifest)).not.toContain("jina-code");
  });

  it("defaults to Qwen3 with the English instruction and no doc prefix", () => {
    expect(DEFAULT_MODEL_ID).toBe("qwen3-embedding-0.6b");
    const q = getModel(DEFAULT_MODEL_ID);
    expect(q.hfRepo.startsWith("onnx-community/")).toBe(true);
    expect(q.queryInstruction).toBe("Instruct: Given a question, retrieve code that answers it\nQuery: ");
    expect(q.docPrefix).toBeUndefined();
    expect(q.dtype).toBe("q8");
  });

  it("pins revisions and describes every file", () => {
    for (const m of manifest.models) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.files.length).toBeGreaterThan(0);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(0);
      }
      expect(m.dims).toBeGreaterThan(0);
      for (const d of m.mrlDims ?? []) expect(d).toBeLessThanOrEqual(m.dims);
      expect(m.maxTokens).toBeGreaterThan(0);
      expect(m.license).not.toBe("");
    }
  });

  it("uses static pooling with safetensors for potion-code-16m", () => {
    const p = getModel("potion-code-16m");
    expect(p.pooling).toBe("static");
    expect(p.files.map((f) => f.path)).toEqual(expect.arrayContaining(["model.safetensors", "tokenizer.json"]));
  });

  it("points the mirror at GitHub Releases", () => {
    expect(manifest.mirror).toEqual({ githubRepo: "code-embed/code-embed", tag: "models-v1" });
  });

  it("throws on unknown model", () => {
    expect(() => getModel("nope")).toThrow(/unknown model/);
  });
});
