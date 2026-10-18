import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmbCache } from "./types";

const BATCH = 500;
const DAY_MS = 86_400_000;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function f32ToF16(x: number): number {
  f32[0] = x;
  const b = u32[0]!;
  const sign = (b >>> 16) & 0x8000;
  const exp = (b >>> 23) & 0xff;
  const mant = b & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = mant | 0x800000;
    const shift = 14 - e;
    let h = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return h;
}

function f16ToF32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function toFloat16(v: Float32Array): Uint16Array {
  const out = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = f32ToF16(v[i]!);
  return out;
}

export function fromFloat16(v: Uint16Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = f16ToF32(v[i]!);
  return out;
}

function toBlob(v: Float32Array): Uint8Array {
  const h = toFloat16(v);
  return new Uint8Array(h.buffer, h.byteOffset, h.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint16Array(b.byteLength / 2);
  new Uint8Array(copy.buffer).set(b);
  return fromFloat16(copy);
}

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}

// SQLite does not call the busy handler when switching to WAL, so initialization is retried by hand.
function initWithRetry(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(`CREATE TABLE IF NOT EXISTS emb (
    model_id TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (model_id, chunk_hash)
  ) WITHOUT ROWID`);
      db.exec("CREATE INDEX IF NOT EXISTS emb_last_used ON emb(last_used)");
      return;
    } catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      Atomics.wait(pause, 0, 0, 10 + Math.random() * 40);
    }
  }
}

export function openEmbCache(path: string): EmbCache {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    initWithRetry(db);
  } catch (e) {
    db.close();
    throw e;
  }

  const put = db.prepare(
    `INSERT INTO emb (model_id, chunk_hash, dims, vector, last_used) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(model_id, chunk_hash) DO UPDATE SET dims = excluded.dims, vector = excluded.vector, last_used = excluded.last_used`,
  );

  return {
    get(modelId, hashes) {
      const out = new Map<string, Float32Array>();
      const now = Date.now();
      let touchSkipped = false;
      for (let i = 0; i < hashes.length; i += BATCH) {
        const part = hashes.slice(i, i + BATCH);
        const ph = part.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT chunk_hash, vector FROM emb WHERE model_id = ? AND chunk_hash IN (${ph})`)
          .all(modelId, ...part) as { chunk_hash: string; vector: Uint8Array }[];
        for (const r of rows) out.set(r.chunk_hash, fromBlob(r.vector));
        if (rows.length > 0 && !touchSkipped) {
          const found = rows.map((r) => r.chunk_hash);
          // last_used only feeds gc; a search-path read must never wait for another process's write lock.
          db.exec("PRAGMA busy_timeout = 0");
          try {
            db.prepare(
              `UPDATE emb SET last_used = ? WHERE model_id = ? AND chunk_hash IN (${found.map(() => "?").join(",")})`,
            ).run(now, modelId, ...found);
          } catch (e) {
            if (!isBusy(e)) throw e;
            touchSkipped = true;
          } finally {
            db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
          }
        }
      }
      return out;
    },
    put(modelId, entries) {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const e of entries) put.run(modelId, e.chunkHash, e.vector.length, toBlob(e.vector), now);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    count(modelId) {
      const row = (
        modelId === undefined
          ? db.prepare("SELECT COUNT(*) AS n FROM emb").get()
          : db.prepare("SELECT COUNT(*) AS n FROM emb WHERE model_id = ?").get(modelId)
      ) as { n: number | bigint };
      return Number(row.n);
    },
    gc({ olderThanDays }) {
      const res = db.prepare("DELETE FROM emb WHERE last_used < ?").run(Date.now() - olderThanDays * DAY_MS);
      return Number(res.changes);
    },
    close() {
      db.close();
    },
  };
}
