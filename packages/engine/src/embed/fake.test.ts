import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "./fake";

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Float32Array): number {
  return Math.sqrt(cosine(a, a));
}

describe("FakeEmbedder", () => {
  it("describes itself", async () => {
    const e = new FakeEmbedder({ dims: 32, model: "m" });
    await e.init();
    expect(e.info).toMatchObject({ provider: "fake", model: "m", dims: 32, modelId: "fake/m@32", remote: false });
  });

  it("is deterministic across instances", async () => {
    const [a] = await new FakeEmbedder().embedDocuments(["processPaymentRefund(order)"]);
    const [b] = await new FakeEmbedder().embedQueries(["processPaymentRefund(order)"]);
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });

  it("returns L2-normalized vectors of the configured size", async () => {
    const vs = await new FakeEmbedder({ dims: 48 }).embedDocuments(["parse config file", "", "оплата заказа"]);
    for (const v of vs) {
      expect(v).toHaveLength(48);
      expect(norm(v)).toBeCloseTo(1, 5);
    }
  });

  it("puts texts with shared words closer", async () => {
    const e = new FakeEmbedder({ dims: 128 });
    const [q, near, far] = await e.embedDocuments([
      "refund payment",
      "class PaymentService { processPaymentRefund() {} }",
      "def parse_config(path): return toml.load(path)",
    ]);
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
    expect(cosine(q!, near!)).toBeGreaterThan(0.3);
  });

  it("honors failWith and abort", async () => {
    const boom = new Error("provider down");
    await expect(new FakeEmbedder({ failWith: boom }).embedQueries(["x"])).rejects.toBe(boom);
    const ac = new AbortController();
    const pending = new FakeEmbedder({ latencyMs: 1000 }).embedQueries(["x"], ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
