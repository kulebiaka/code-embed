import type { Embedder, ModelEntry } from "./types";

export interface LocalEmbedderOptions {
  modelsDir: string;
  threads: number;
  dims?: number;
  offlineArchive?: string;
  proxy?: string;
}

export function createLocalEmbedder(_entry: ModelEntry, _opts: LocalEmbedderOptions): Embedder {
  throw new Error("not implemented: embed/local.createLocalEmbedder");
}

export function formatQuery(_entry: ModelEntry, _query: string): string {
  throw new Error("not implemented: embed/local.formatQuery");
}

export function formatDocument(_entry: ModelEntry, _text: string): string {
  throw new Error("not implemented: embed/local.formatDocument");
}
