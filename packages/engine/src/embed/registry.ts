import type { EffectiveSettings } from "../config/types";
import type { Embedder } from "./types";

export function isLoopbackUrl(_url: string): boolean {
  throw new Error("not implemented: embed/registry.isLoopbackUrl");
}

export interface ResolveEmbedderOptions {
  root: string;
  settings: EffectiveSettings;
  apiKeys?: Record<string, string>;
}

export function resolveEmbedder(_opts: ResolveEmbedderOptions): Promise<Embedder> {
  throw new Error("not implemented: embed/registry.resolveEmbedder");
}

export function describeProvider(_settings: EffectiveSettings): { provider: string; remote: boolean; host?: string } {
  throw new Error("not implemented: embed/registry.describeProvider");
}
