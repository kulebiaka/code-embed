import { describe, expect, it } from "vitest";
import { modelIdOf, parseModelId } from "./model-id";

describe("model-id", () => {
  it("formats <provider>/<model>@<dims>", () => {
    expect(modelIdOf("local", "qwen3-embedding-0.6b", 1024)).toBe("local/qwen3-embedding-0.6b@1024");
  });

  it("round-trips, including models with slashes", () => {
    expect(parseModelId("local/qwen3-embedding-0.6b@1024")).toEqual({
      provider: "local",
      model: "qwen3-embedding-0.6b",
      dims: 1024,
    });
    expect(parseModelId(modelIdOf("corp", "BAAI/bge-m3", 768))).toEqual({ provider: "corp", model: "BAAI/bge-m3", dims: 768 });
  });

  it("rejects malformed ids", () => {
    expect(parseModelId("local/model")).toBeNull();
    expect(parseModelId("model@1024")).toBeNull();
    expect(parseModelId("local/model@0")).toBeNull();
    expect(parseModelId("local/model@abc")).toBeNull();
    expect(parseModelId("/model@3")).toBeNull();
  });
});
