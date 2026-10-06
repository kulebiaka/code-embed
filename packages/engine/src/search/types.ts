import type { EmbCache } from "../cache/types";
import type { Embedder } from "../embed/types";
import type { IndexStore } from "../store/types";

export interface SearchContext {
  store: IndexStore;
  embCache: EmbCache | null;
  embedder: Embedder | null;
  modelId: string | null;
  vectorsReady: () => { ratio: number; ready: boolean };
  embedderError?: string;
}
