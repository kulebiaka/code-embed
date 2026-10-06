import { describe, expect, it } from "vitest";
import { buildEmbeddingText } from "./header";
import type { Chunk } from "./types";

const chunk: Chunk = {
  startLine: 1,
  endLine: 3,
  startByte: 0,
  endByte: 10,
  kind: "method",
  symbol: "processPaymentRefund",
  parentSymbol: "PaymentService",
  signature: "processPaymentRefund(id: string): void",
  text: "// refund it\nprocessPaymentRefund(id) {}",
};

describe("buildEmbeddingText", () => {
  it("builds header with split words and keeps text", () => {
    const out = buildEmbeddingText(chunk, { path: "src/pay.ts", lang: "typescript" });
    expect(out).toContain("path: src/pay.ts");
    expect(out).toContain("lang: typescript");
    expect(out).toContain("parent_symbol: PaymentService");
    expect(out).toContain("signature: processPaymentRefund(id: string): void");
    expect(out).toMatch(/symbols: .*process payment refund/);
    expect(out.endsWith(chunk.text)).toBe(true);
    expect(out).toContain("// refund it");
  });

  it("does not mutate chunk.text and omits empty fields", () => {
    const c = { ...chunk, symbol: null, parentSymbol: null, signature: null };
    const out = buildEmbeddingText(c, { path: "a.txt", lang: null });
    expect(out).toBe(`path: a.txt\n\n${chunk.text}`);
    expect(c.text).toBe(chunk.text);
  });
});
