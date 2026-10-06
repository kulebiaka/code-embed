import { IndexCorruptError } from "../errors";
import { isCorruptionError, openDatabase, type Db, type Row } from "./driver";
import type {
  ChunkInput,
  ChunkRecord,
  FileInput,
  FileRecord,
  FtsHit,
  IndexStore,
  StoreFilter,
  VecHit,
} from "./types";

export interface OpenStoreOptions {
  readonly?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lang TEXT,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  parent_symbol TEXT,
  chunk_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS chunks_embedded ON chunks(embedded);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, symbol, path, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const CHUNK_SELECT = `SELECT c.id, c.file_id, f.path, f.lang, c.start_line, c.end_line, c.start_byte, c.end_byte,
  c.kind, c.symbol, c.parent_symbol, c.chunk_hash, c.text, c.embedded
  FROM chunks c JOIN files f ON f.id = c.file_id`;

function fileRecord(r: Row): FileRecord {
  return {
    id: r.id,
    path: r.path,
    lang: r.lang,
    size: r.size,
    mtime: r.mtime,
    contentHash: r.content_hash,
    indexedAt: r.indexed_at,
  };
}

function chunkRecord(r: Row): ChunkRecord {
  return {
    id: r.id,
    fileId: r.file_id,
    path: r.path,
    lang: r.lang,
    startLine: r.start_line,
    endLine: r.end_line,
    startByte: r.start_byte,
    endByte: r.end_byte,
    kind: r.kind,
    symbol: r.symbol,
    parentSymbol: r.parent_symbol,
    chunkHash: r.chunk_hash,
    text: r.text,
    embedded: r.embedded === 1,
  };
}

function asBytes(v: Int8Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

function filterSql(filter: StoreFilter | undefined): { sql: string; params: (string | number)[] } {
  let sql = "";
  const params: (string | number)[] = [];
  if (filter?.lang !== undefined) {
    sql += " AND f.lang = ?";
    params.push(filter.lang);
  }
  if (filter?.pathPrefix) {
    sql += " AND substr(f.path, 1, ?) = ?";
    params.push(filter.pathPrefix.length, filter.pathPrefix);
  }
  return { sql, params };
}

export function openIndexStore(dbPath: string, opts?: OpenStoreOptions): IndexStore {
  const readonly = opts?.readonly ?? false;
  let db: Db | undefined;
  try {
    db = openDatabase(dbPath, readonly);
    db.exec("PRAGMA foreign_keys = ON");
    if (!readonly) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(SCHEMA);
    }
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (e) {
    db?.close();
    if (isCorruptionError(e)) throw new IndexCorruptError(`index database is corrupt: ${dbPath}`);
    throw e;
  }
  return new SqliteStore(db, readonly);
}

class SqliteStore implements IndexStore {
  dims: number | null = null;
  private depth = 0;
  private hasVec: boolean;

  constructor(
    private db: Db,
    readonly readonly: boolean,
  ) {
    this.hasVec = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunks_vec'").get();
    const d = this.getMeta("vec_dims");
    this.dims = this.hasVec && d ? Number(d) : null;
  }

  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const sp = `sp${this.depth}`;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.db.exec(outer ? "COMMIT" : `RELEASE ${sp}`);
      return result;
    } catch (e) {
      if (this.depth > 0) this.depth--;
      this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  getFile(path: string): FileRecord | undefined {
    const r = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path);
    return r ? fileRecord(r) : undefined;
  }

  listFiles(): FileRecord[] {
    return this.db.prepare("SELECT * FROM files ORDER BY path").all().map(fileRecord);
  }

  private deleteChunksOf(fileId: number): void {
    const ids = this.db.prepare("SELECT id FROM chunks WHERE file_id = ?").all(fileId).map((r) => r.id as number);
    if (ids.length === 0) return;
    const delFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    const delVec = this.hasVec ? this.db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?") : null;
    for (const id of ids) {
      delFts.run(id);
      delVec?.run(BigInt(id));
    }
    this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
  }

  upsertFile(file: FileInput, chunks: ChunkInput[]): { fileId: number; chunkIds: number[] } {
    return this.transaction(() => {
      const now = Date.now();
      const existing = this.db.prepare("SELECT id FROM files WHERE path = ?").get(file.path);
      let fileId: number;
      if (existing) {
        fileId = existing.id;
        this.deleteChunksOf(fileId);
        this.db
          .prepare("UPDATE files SET lang = ?, size = ?, mtime = ?, content_hash = ?, indexed_at = ? WHERE id = ?")
          .run(file.lang, file.size, file.mtime, file.contentHash, now, fileId);
      } else {
        const res = this.db
          .prepare("INSERT INTO files(path, lang, size, mtime, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(file.path, file.lang, file.size, file.mtime, file.contentHash, now);
        fileId = Number(res.lastInsertRowid);
      }
      const insChunk = this.db.prepare(
        `INSERT INTO chunks(file_id, start_line, end_line, start_byte, end_byte, kind, symbol, parent_symbol, chunk_hash, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insFts = this.db.prepare("INSERT INTO chunks_fts(rowid, text, symbol, path) VALUES (?, ?, ?, ?)");
      const chunkIds: number[] = [];
      for (const c of chunks) {
        const res = insChunk.run(
          fileId,
          c.startLine,
          c.endLine,
          c.startByte,
          c.endByte,
          c.kind,
          c.symbol,
          c.parentSymbol,
          c.chunkHash,
          c.text,
        );
        const id = Number(res.lastInsertRowid);
        insFts.run(id, c.fts.text, c.fts.symbol, c.fts.path);
        chunkIds.push(id);
      }
      return { fileId, chunkIds };
    });
  }

  deleteFile(path: string): void {
    this.transaction(() => {
      const f = this.db.prepare("SELECT id FROM files WHERE path = ?").get(path);
      if (!f) return;
      this.deleteChunksOf(f.id);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
    });
  }

  getChunks(ids: number[]): ChunkRecord[] {
    const out: ChunkRecord[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...this.db.prepare(`${CHUNK_SELECT} WHERE c.id IN (${placeholders(part.length)})`).all(...part).map(chunkRecord));
    }
    return out;
  }

  chunksForFile(path: string): ChunkRecord[] {
    return this.db.prepare(`${CHUNK_SELECT} WHERE f.path = ? ORDER BY c.start_byte, c.id`).all(path).map(chunkRecord);
  }

  pendingChunks(limit: number, paths?: string[]): ChunkRecord[] {
    if (paths && paths.length === 0) return [];
    const pathSql = paths ? ` AND f.path IN (${placeholders(paths.length)})` : "";
    return this.db
      .prepare(`${CHUNK_SELECT} WHERE c.embedded = 0${pathSql} ORDER BY c.id LIMIT ?`)
      .all(...(paths ?? []), limit)
      .map(chunkRecord);
  }

  setVectorDims(dims: number): void {
    if (!Number.isInteger(dims) || dims <= 0) throw new Error(`invalid vector dims: ${dims}`);
    this.transaction(() => {
      this.db.exec("DROP TABLE IF EXISTS chunks_vec");
      this.db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding int8[${dims}])`);
      this.db.exec("UPDATE chunks SET embedded = 0");
      this.setMeta("vec_dims", String(dims));
    });
    this.hasVec = true;
    this.dims = dims;
  }

  setEmbeddings(items: { chunkId: number; vector: Int8Array }[]): void {
    if (!this.hasVec) throw new Error("vector dims are not set");
    this.transaction(() => {
      const del = this.db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?");
      const ins = this.db.prepare("INSERT INTO chunks_vec(chunk_id, embedding) VALUES (?, vec_int8(?))");
      const mark = this.db.prepare("UPDATE chunks SET embedded = 1 WHERE id = ?");
      for (const { chunkId, vector } of items) {
        del.run(BigInt(chunkId));
        ins.run(BigInt(chunkId), asBytes(vector));
        mark.run(chunkId);
      }
    });
  }

  searchFts(match: string, limit: number, filter?: StoreFilter): FtsHit[] {
    const { sql, params } = filterSql(filter);
    const rows = this.db
      .prepare(
        `SELECT chunks_fts.rowid AS id, bm25(chunks_fts, 1.0, 3.0, 1.5) AS s
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN files f ON f.id = c.file_id
         WHERE chunks_fts MATCH ?${sql} ORDER BY s LIMIT ?`,
      )
      .all(match, ...params, limit);
    return rows.map((r) => ({ chunkId: r.id, score: -r.s }));
  }

  searchVec(query: Int8Array, k: number, filter?: StoreFilter): VecHit[] {
    if (!this.hasVec || k <= 0) return [];
    const knn = this.db.prepare(
      "SELECT chunk_id AS id, distance FROM chunks_vec WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance",
    );
    const q = asBytes(query);
    if (!filter?.lang && !filter?.pathPrefix) {
      return knn.all(q, k).map((r) => ({ chunkId: r.id, distance: r.distance }));
    }
    const { sql, params } = filterSql(filter);
    const total = this.counts().embedded;
    let fetch = Math.min(Math.max(k * 4, 64), Math.max(total, 1));
    for (;;) {
      const cands = knn.all(q, fetch);
      const ids = cands.map((r) => r.id as number);
      const ok = new Set<number>();
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        const rows = this.db
          .prepare(`SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id IN (${placeholders(part.length)})${sql}`)
          .all(...part, ...params);
        for (const r of rows) ok.add(r.id);
      }
      const hits = cands.filter((r) => ok.has(r.id)).map((r) => ({ chunkId: r.id as number, distance: r.distance as number }));
      if (hits.length >= k || fetch >= total || cands.length < fetch) return hits.slice(0, k);
      fetch = Math.min(fetch * 4, total);
    }
  }

  getVectors(chunkIds: number[]): Map<number, Int8Array> {
    const out = new Map<number, Int8Array>();
    if (!this.hasVec) return out;
    for (let i = 0; i < chunkIds.length; i += 500) {
      const part = chunkIds.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT chunk_id AS id, embedding FROM chunks_vec WHERE chunk_id IN (${placeholders(part.length)})`)
        .all(...part.map(BigInt));
      for (const r of rows) {
        const b = r.embedding as Uint8Array;
        out.set(r.id, new Int8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
      }
    }
    return out;
  }

  counts(): { files: number; chunks: number; embedded: number } {
    const f = this.db.prepare("SELECT count(*) AS n FROM files").get()!;
    const c = this.db.prepare("SELECT count(*) AS n, coalesce(sum(embedded), 0) AS e FROM chunks").get()!;
    return { files: f.n, chunks: c.n, embedded: c.e };
  }

  getMeta(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  checkpoint(): void {
    if (!this.readonly) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }
}
