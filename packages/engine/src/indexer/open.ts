import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CHUNKER_VERSION, DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import type { EffectiveSettings } from "../config/types";
import { dockerignoreWarning, ensureIndexDir, INDEX_DB } from "../core/index-dir";
import { resolveIndexDir } from "../core/location";
import { acquireLock, type LockHandle } from "../core/lock";
import { type IndexMeta, readMeta, SCHEMA_VERSION, writeMeta } from "../core/meta";
import { IndexCorruptError, NoIndexError } from "../errors";
import { openIndexStore } from "../store/sqlite";
import type { IndexStore } from "../store/types";
import { log } from "../util/log";
import { runLexical } from "./lexical";

export interface OpenedIndex {
  store: IndexStore;
  meta: IndexMeta;
  indexDir: string;
  created: boolean;
  rebuildReason?: string;
  lock: LockHandle | null;
  readOnly: boolean;
}

export interface OpenIndexOptions {
  readonly?: boolean;
  expectedModelId?: string | null;
  dims?: number | null;
  requireExisting?: boolean;
}

const CORRUPT = "index database is corrupt";

function removeDb(path: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
}

async function rebuild(root: string, indexDir: string, settings: EffectiveSettings, reason: string): Promise<void> {
  log.warn(`rebuilding index: ${reason}`);
  const dbPath = join(indexDir, INDEX_DB);
  const newPath = `${dbPath}.new`;
  removeDb(newPath);
  const store = openIndexStore(newPath);
  try {
    await runLexical({
      root,
      indexDir,
      store,
      settings,
      chunkOptions: DEFAULT_CHUNK_OPTIONS,
      onProgress: () => {},
      onError: (e) => log.warn(`${e.path ?? ""} ${e.message}`.trim()),
    });
    store.checkpoint();
  } catch (e) {
    store.close();
    removeDb(newPath);
    throw e;
  }
  store.close();
  removeDb(dbPath);
  renameSync(newPath, dbPath);
  rmSync(`${newPath}-wal`, { force: true });
  rmSync(`${newPath}-shm`, { force: true });
}

export async function openIndex(
  root: string,
  settings: EffectiveSettings,
  opts: OpenIndexOptions,
): Promise<OpenedIndex> {
  const indexDir = resolveIndexDir(root, settings.indexLocation).dir;
  const dbPath = join(indexDir, INDEX_DB);
  const exists = existsSync(dbPath);
  if (!exists && (opts.requireExisting || opts.readonly)) {
    throw new NoIndexError("no index found; run `code-embed index`");
  }

  let dirCreated = false;
  let lock: LockHandle | null = null;
  if (!opts.readonly) {
    dirCreated = ensureIndexDir(indexDir).created;
    if (dirCreated) {
      const warning = dockerignoreWarning(root);
      if (warning) log.warn(warning);
    }
    lock = acquireLock(indexDir);
    if (!lock && !exists) throw new NoIndexError("index is locked by another process and does not exist yet");
  }
  const readOnly = lock === null;

  const found = readMeta(indexDir);
  const expected: IndexMeta = {
    schema_version: SCHEMA_VERSION,
    model_id: opts.expectedModelId === undefined ? (found?.model_id ?? null) : opts.expectedModelId,
    model_sha: found?.model_sha ?? null,
    chunker_version: CHUNKER_VERSION,
    dims: opts.dims === undefined ? (found?.dims ?? null) : opts.dims,
  };

  let rebuildReason: string | undefined;
  let modelChanged = false;
  if (exists) {
    if (!found) rebuildReason = "meta.json is missing or corrupt";
    else if (found.schema_version !== SCHEMA_VERSION) rebuildReason = "schema version changed";
    else if (found.chunker_version !== CHUNKER_VERSION) rebuildReason = "chunker version changed";
    else modelChanged = found.model_id !== expected.model_id || found.dims !== expected.dims;
  }

  try {
    let store: IndexStore | undefined;
    if (exists && !rebuildReason) {
      try {
        store = openIndexStore(dbPath, { readonly: readOnly });
      } catch (e) {
        if (!(e instanceof IndexCorruptError)) throw e;
        rebuildReason = CORRUPT;
      }
    }
    if (rebuildReason && readOnly) {
      if (rebuildReason === CORRUPT) throw new IndexCorruptError(CORRUPT);
      store = openIndexStore(dbPath, { readonly: true });
      return { store, meta: found ?? expected, indexDir, created: false, lock, readOnly };
    }
    if (rebuildReason) await rebuild(root, indexDir, settings, rebuildReason);
    store ??= openIndexStore(dbPath, { readonly: readOnly });

    if (readOnly) return { store, meta: found ?? expected, indexDir, created: false, lock, readOnly };

    if (modelChanged) log.warn("embedding model changed: vectors will be rebuilt, lexical index is kept");
    if ((modelChanged || !exists || rebuildReason) && expected.dims) store.setVectorDims(expected.dims);
    if (!found || rebuildReason || modelChanged) writeMeta(indexDir, expected);
    return { store, meta: expected, indexDir, created: !exists, rebuildReason, lock, readOnly };
  } catch (e) {
    lock?.release();
    throw e;
  }
}
