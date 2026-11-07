import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSandbox, parseJsonLines, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe("CLI without an index (R-85, R-87)", () => {
  it("returns lexical results with exit 0 and a warning on stderr", async () => {
    const r = await sb.run(["refund", "payment"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^src\/payment\/refund\.ts:\d+:\d+: /m);
    expect(r.stderr).toContain("vectors are not built yet");
    expect(r.stderr).toContain("code-embed index");
  });

  it("exits 1 when nothing matches", async () => {
    const r = await sb.run(["zzqxnomatchtoken"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("exits 2 on an unknown option", async () => {
    const r = await sb.run(["--bogus", "refund"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--bogus");
  });
});

describe("CLI after index (R-80, R-82, R-83)", () => {
  beforeEach(async () => {
    const r = await sb.run(["index"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/vectors (\d+)\/\1/);
  });

  it("finds processPaymentRefund with a hybrid query", async () => {
    const r = await sb.run(["--json", "-n", "20", "refund", "payment"]);
    expect(r.code).toBe(0);
    const rows = parseJsonLines(r.stdout);
    expect(rows.some((x) => String(x.snippet).includes("processPaymentRefund"))).toBe(true);
    expect(rows.some((x) => (x.sources as string[]).includes("semantic"))).toBe(true);
  });

  it("prints ripgrep-style lines", async () => {
    const r = await sb.run(["refund", "payment"]);
    expect(r.code).toBe(0);
    for (const line of r.stdout.trim().split("\n")) expect(line).toMatch(/^[^:\s]+:\d+:\d+: /);
  });

  it("prints JSONL with exactly the R-83 fields", async () => {
    const r = await sb.run(["--json", "refund"]);
    const rows = parseJsonLines(r.stdout);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["end_line", "kind", "path", "score", "snippet", "sources", "start_line", "symbol"].sort(),
      );
      expect(typeof row.score).toBe("number");
      expect(Array.isArray(row.sources)).toBe(true);
    }
  });

  it("similar does not return chunks overlapping the query range", async () => {
    const [a, b] = [33, 45];
    const r = await sb.run(["similar", `src/payment/refund.ts:${a}-${b}`, "--json", "-n", "20"]);
    expect(r.code).toBe(0);
    const rows = parseJsonLines(r.stdout);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.path !== "src/payment/refund.ts") continue;
      const overlaps = (row.start_line as number) <= b && (row.end_line as number) >= a;
      expect(overlaps).toBe(false);
    }
  });

  it("similar - reads code from stdin", async () => {
    const r = await sb.run(["similar", "-", "--lang", "ts", "--json"], {
      input: "function refundAmount(payment, requested) { return payment.amountCents - payment.refundedCents; }",
    });
    expect(r.code).toBe(0);
    expect(parseJsonLines(r.stdout).length).toBeGreaterThan(0);
  });

  it("outline prints text and JSON", async () => {
    const text = await sb.run(["outline", "src/payment/refund.ts"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("calculateRefundAmount");

    const json = await sb.run(["outline", "src/payment/refund.ts", "--json"]);
    expect(json.code).toBe(0);
    const resp = JSON.parse(json.stdout);
    expect(resp.path).toBe("src/payment/refund.ts");
    expect(resp.symbols.map((s: { symbol: string }) => s.symbol)).toContain("calculateRefundAmount");
  });

  it("refs prints text and JSON, and --path restricts definitions", async () => {
    const text = await sb.run(["refs", "calculateRefundAmount"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("src/payment/refund.ts");

    const json = await sb.run(["refs", "calculateRefundAmount", "--json"]);
    expect(json.code).toBe(0);
    const resp = JSON.parse(json.stdout);
    expect(resp.symbol).toBe("calculateRefundAmount");
    expect(resp.items.some((x: { role: string }) => x.role === "definition")).toBe(true);
    expect(resp.items.some((x: { role: string; confidence: string }) => x.role === "usage" && x.confidence)).toBe(true);

    const scoped = await sb.run(["refs", "calculateRefundAmount", "--path", "src/payment/refund.ts", "--json"]);
    expect(scoped.code).toBe(0);
    const defs = JSON.parse(scoped.stdout).items.filter((x: { role: string }) => x.role === "definition");
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.every((x: { path: string }) => x.path === "src/payment/refund.ts")).toBe(true);

    const other = await sb.run(["refs", "calculateRefundAmount", "--path", "src/App.tsx", "--json"]);
    const otherDefs = JSON.parse(other.stdout).items.filter((x: { role: string }) => x.role === "definition");
    expect(otherDefs).toEqual([]);
  });

  it("context prints text and JSON, and --budget caps the budget", async () => {
    const text = await sb.run(["context", "src/payment/refund.ts:64"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("processPaymentRefund");

    const json = await sb.run(["context", "src/payment/refund.ts:64", "--json"]);
    expect(json.code).toBe(0);
    const resp = JSON.parse(json.stdout);
    expect(resp.chunks[0].level).toBe("target");
    expect(resp.budgetTokens).toBe(4000);

    const budgeted = await sb.run(["context", "src/payment/refund.ts:64", "--budget", "500", "--json"]);
    expect(budgeted.code).toBe(0);
    expect(JSON.parse(budgeted.stdout).budgetTokens).toBe(500);

    const query = await sb.run(["context", "refund payment", "--json"]);
    expect(query.code).toBe(0);
    expect(JSON.parse(query.stdout).chunks.length).toBeGreaterThan(0);
  });
});
