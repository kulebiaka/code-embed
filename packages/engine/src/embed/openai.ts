import type { ProviderConfig } from "@code-embed/protocol";
import type { Embedder } from "./types";

export interface OpenAIEmbedderOptions {
  name: string;
  config: ProviderConfig;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createOpenAIEmbedder(_opts: OpenAIEmbedderOptions): Embedder {
  throw new Error("not implemented: embed/openai.createOpenAIEmbedder");
}
