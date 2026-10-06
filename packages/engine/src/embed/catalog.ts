import manifest from "./models.json";
import type { ModelEntry, ModelManifest } from "./types";

export const DEFAULT_MODEL_ID = "qwen3-embedding-0.6b";

export function loadManifest(): ModelManifest {
  return manifest as ModelManifest;
}

export function getModel(id: string): ModelEntry {
  const entry = loadManifest().models.find((m) => m.id === id);
  if (!entry) {
    const known = loadManifest().models.map((m) => m.id).join(", ");
    throw new Error(`unknown model "${id}" (available: ${known})`);
  }
  return entry;
}
