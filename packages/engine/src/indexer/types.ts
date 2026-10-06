import type { IndexErrorParams, IndexProgress } from "@code-embed/protocol";
import type { ChunkOptions } from "../chunk/types";
import type { EffectiveSettings } from "../config/types";
import type { IndexStore } from "../store/types";

export interface IndexerContext {
  root: string;
  indexDir: string;
  store: IndexStore;
  settings: EffectiveSettings;
  chunkOptions: ChunkOptions;
  onProgress: (p: IndexProgress) => void;
  onError: (e: IndexErrorParams) => void;
}

export interface LexicalRunResult {
  scanned: number;
  changed: number;
  deleted: number;
  skipped: number;
  timedOut: boolean;
}

// Absolute paths.
export interface PathChanges {
  created: string[];
  changed: string[];
  deleted: string[];
}
