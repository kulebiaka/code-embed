import { existsSync } from "node:fs";
import { log } from "../util/log";
import { grammarPath } from "./assets";
import { chunkWindows } from "./fallback";
import { LANGUAGES } from "./languages";
import { chunkMarkdown } from "./markdown";
import { chunkWithTreeSitter, initTreeSitter } from "./treesitter";
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions, type ChunkResult } from "./types";

export function initChunker(): Promise<void> {
  return initTreeSitter();
}

export async function chunkFile(
  path: string,
  lang: string | null,
  content: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<ChunkResult> {
  if (lang === "markdown") return { chunks: chunkMarkdown(content, opts), refs: [] };
  if (lang && hasGrammar(lang)) {
    try {
      return await chunkWithTreeSitter(lang, content, opts);
    } catch (e) {
      log.warn(`tree-sitter failed for ${path}, falling back to windows: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { chunks: chunkWindows(content), refs: [] };
}

export function hasGrammar(lang: string | null): boolean {
  if (!lang || !Object.hasOwn(LANGUAGES, lang)) return false;
  try {
    return existsSync(grammarPath(lang));
  } catch {
    return false;
  }
}
