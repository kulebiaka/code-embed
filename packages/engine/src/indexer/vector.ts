import type { EmbCache } from "../cache/types";
import type { Embedder } from "../embed/types";
import type { IndexerContext } from "./types";

export interface VectorPhase {
  start(): void;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  prioritize(paths: string[]): void;
  notifyChanged(paths: string[]): void;
  readonly state: "idle" | "running" | "paused" | "waiting-provider";
  whenIdle(): Promise<void>;
}

export interface VectorPhaseDeps {
  ctx: IndexerContext;
  embCache: EmbCache;
  embedder: Embedder;
  batchSize?: number;
  commitEvery?: number;
}

export function createVectorPhase(_deps: VectorPhaseDeps): VectorPhase {
  throw new Error("not implemented: indexer/vector.createVectorPhase");
}
