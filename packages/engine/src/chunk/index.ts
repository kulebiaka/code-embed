import { existsSync } from "node:fs";
import { log } from "../util/log";
import { grammarPath } from "./assets";
import { chunkWindows } from "./fallback";
import { LANGUAGES } from "./languages";
import { chunkMarkdown } from "./markdown";
import { chunkWithTreeSitter, initTreeSitter } from "./treesitter";
import { DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions } from "./types";

export function initChunker(): Promise<void> {
  return initTreeSitter();
}

export async function chunkFile(
  path: string,
  lang: string | null,
  content: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<Chunk[]> {
  if (lang === "markdown") return chunkMarkdown(content, opts);
  if (lang && hasGrammar(lang)) {
    try {
      return await chunkWithTreeSitter(lang, content, opts);
    } catch (e) {
      log.warn(`tree-sitter failed for ${path}, falling back to windows: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return chunkWindows(content);
}

export function hasGrammar(lang: string | null): boolean {
  if (!lang || !Object.hasOwn(LANGUAGES, lang)) return false;
  try {
    return existsSync(grammarPath(lang));
  } catch {
    return false;
  }
}
