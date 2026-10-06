import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import { describe, expect, it } from "vitest";

function blob(v: number[]): Uint8Array {
  const i8 = Int8Array.from(v);
  return new Uint8Array(i8.buffer, i8.byteOffset, i8.byteLength);
}

describe("sqlite driver smoke", () => {
  it("loads sqlite-vec into node:sqlite and runs int8 kNN", () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    db.loadExtension(getLoadablePath());
    db.exec("CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding int8[4])");
    const insert = db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, vec_int8(?))");
    // vec0 rejects REAL rowids, and node:sqlite binds JS numbers as REAL: pass bigint.
    insert.run(1n, blob([127, 0, 0, 0]));
    insert.run(2n, blob([0, 127, 0, 0]));
    insert.run(3n, blob([100, 20, 0, 0]));
    const rows = db
      .prepare("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH vec_int8(?) AND k = 2 ORDER BY distance")
      .all(blob([127, 1, 0, 0])) as { rowid: number; distance: number }[];
    expect(rows.map((r) => r.rowid)).toEqual([1, 3]);
    db.close();
  });

  it("has fts5 with the unicode61 tokenizer", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, symbol, path, tokenize = 'unicode61 remove_diacritics 2')");
    const insert = db.prepare("INSERT INTO chunks_fts(rowid, text, symbol, path) VALUES (?, ?, ?, ?)");
    insert.run(1, "process payment refund", "processPaymentRefund", "src/payment/refund.ts");
    insert.run(2, "Возврат ОПЛАТЫ клиенту", "", "docs/guide.md");
    insert.run(3, "parse config", "parse_config", "src/utils/parse_config.py");
    const q = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 1.0, 3.0, 2.0)");
    expect((q.all("refund") as { rowid: number }[]).map((r) => r.rowid)).toEqual([1]);
    expect((q.all("оплаты") as { rowid: number }[]).map((r) => r.rowid)).toEqual([2]);
    db.close();
  });
});
