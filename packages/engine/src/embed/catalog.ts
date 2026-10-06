import type { ModelEntry, ModelManifest } from "./types";

export const DEFAULT_MODEL_ID = "qwen3-embedding-0.6b";

export function loadManifest(): ModelManifest {
  throw new Error("not implemented: embed/catalog.loadManifest");
}

export function getModel(_id: string): ModelEntry {
  throw new Error("not implemented: embed/catalog.getModel");
}
