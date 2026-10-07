import { stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { chunkFile, initChunker } from "../chunk";
import { chunkHash } from "../chunk/hash";
import { tokenizeForFts } from "../lex/tokenize";
import { detectLang } from "../scan/lang";
import { readCandidate } from "../scan/read";
import { createIgnoreMatcher, scanFiles } from "../scan/scan";
import type { ScannedFile } from "../scan/types";
import type { ChunkInput, FileInput } from "../store/types";
import type { IndexerContext, LexicalRunResult, PathChanges } from "./types";

const BATCH_FILES = 50;

interface Prepared {
  file: FileInput;
  chunks: ChunkInput[];
}

async function prepare(
  ctx: IndexerContext,
  file: ScannedFile,
  existingHash: string | undefined,
  force: boolean,
): Promise<Prepared | "unchanged" | "skip"> {
  const read = await readCandidate(file);
  if ("skip" in read) return "skip";
  if (!force && read.hash === existingHash) return "unchanged";
  const chunks = await chunkFile(file.path, file.lang, read.content, ctx.chunkOptions);
  const pathFts = tokenizeForFts(file.path);
  const inputs: ChunkInput[] = [];
  for (const c of chunks) {
    inputs.push({
      startLine: c.startLine,
      endLine: c.endLine,
      startByte: c.startByte,
      endByte: c.endByte,
      kind: c.kind,
      symbol: c.symbol,
      parentSymbol: c.parentSymbol,
      signature: c.signature,
      chunkHash: await chunkHash(c.text),
      text: c.text,
      fts: { text: tokenizeForFts(c.text), symbol: tokenizeForFts(c.symbol ?? ""), path: pathFts },
    });
  }
  return {
    file: { path: file.path, lang: file.lang, size: file.size, mtime: file.mtimeMs, contentHash: read.hash },
    chunks: inputs,
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runLexical(
  ctx: IndexerContext,
  opts?: { full?: boolean; budgetMs?: number; signal?: AbortSignal },
): Promise<LexicalRunResult> {
  const { store } = ctx;
  const started = Date.now();
  const full = opts?.full ?? false;
  await initChunker();

  ctx.onProgress({ phase: "scanning", done: 0, total: 0, embedded: 0 });
  const scanned: ScannedFile[] = [];
  for await (const f of scanFiles(ctx.root, {
    exclude: ctx.settings.exclude,
    maxFileKb: ctx.settings.maxFileKb,
    signal: opts?.signal,
  })) {
    scanned.push(f);
  }

  const existing = new Map(store.listFiles().map((f) => [f.path, f]));
  const result: LexicalRunResult = { scanned: scanned.length, changed: 0, deleted: 0, skipped: 0, timedOut: false };
  let batch: Prepared[] = [];
  let touches: ScannedFile[] = [];
  const flush = (): void => {
    if (batch.length === 0 && touches.length === 0) return;
    const items = batch;
    const touched = touches;
    batch = [];
    touches = [];
    store.transaction(() => {
      for (const p of items) store.upsertFile(p.file, p.chunks);
      for (const f of touched) store.touchFile(f.path, f.mtimeMs, f.size);
    });
  };

  let done = 0;
  let complete = true;
  for (const file of scanned) {
    if (opts?.signal?.aborted) {
      complete = false;
      break;
    }
    if (opts?.budgetMs !== undefined && Date.now() - started > opts.budgetMs) {
      result.timedOut = true;
      complete = false;
      break;
    }
    const rec = existing.get(file.path);
    if (!full && rec && rec.size === file.size && rec.mtime === file.mtimeMs) {
      result.skipped++;
    } else {
      try {
        const p = await prepare(ctx, file, rec?.contentHash, full);
        if (p === "unchanged") {
          result.skipped++;
          touches.push(file);
        }
        else if (p === "skip") {
          result.skipped++;
          if (rec) {
            flush();
            store.deleteFile(file.path);
          }
        } else {
          batch.push(p);
          result.changed++;
          if (batch.length >= BATCH_FILES) flush();
        }
      } catch (e) {
        ctx.onError({ path: file.path, message: errMessage(e) });
      }
    }
    done++;
    if (done % BATCH_FILES === 0) {
      ctx.onProgress({ phase: "lexical", done, total: scanned.length, embedded: store.counts().embedded });
    }
  }
  flush();

  if (complete) {
    const seen = new Set(scanned.map((f) => f.path));
    const gone = [...existing.keys()].filter((p) => !seen.has(p));
    if (gone.length > 0) {
      store.transaction(() => {
        for (const p of gone) store.deleteFile(p);
      });
      result.deleted = gone.length;
    }
  }
  ctx.onProgress({ phase: "lexical", done, total: scanned.length, embedded: store.counts().embedded });
  return result;
}

export async function applyChanges(ctx: IndexerContext, changes: PathChanges): Promise<{ changedPaths: string[] }> {
  const { store } = ctx;
  await initChunker();
  const isIgnored = await createIgnoreMatcher(ctx.root, ctx.settings.exclude);
  const maxBytes = ctx.settings.maxFileKb * 1024;
  const toRel = (abs: string): string | null => {
    const rel = relative(ctx.root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
  };

  const deletes = new Set<string>();
  for (const abs of changes.deleted) {
    const rel = toRel(abs);
    if (rel) deletes.add(rel);
  }

  const prepared: Prepared[] = [];
  const touched: ScannedFile[] = [];
  for (const abs of new Set([...changes.created, ...changes.changed])) {
    const rel = toRel(abs);
    if (!rel) continue;
    try {
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile() || st.size > maxBytes || isIgnored(rel, false)) {
        deletes.add(rel);
        continue;
      }
      const file: ScannedFile = { path: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, lang: detectLang(rel) };
      const p = await prepare(ctx, file, store.getFile(rel)?.contentHash, false);
      if (p === "skip") deletes.add(rel);
      else if (p === "unchanged") touched.push(file);
      else prepared.push(p);
    } catch (e) {
      ctx.onError({ path: rel, message: errMessage(e) });
    }
  }

  const changedPaths: string[] = [];
  store.transaction(() => {
    for (const rel of deletes) {
      if (store.getFile(rel)) store.deleteFile(rel);
    }
    for (const f of touched) store.touchFile(f.path, f.mtimeMs, f.size);
    for (const p of prepared) {
      store.upsertFile(p.file, p.chunks);
      changedPaths.push(p.file.path);
    }
  });
  return { changedPaths };
}
