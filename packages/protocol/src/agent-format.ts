import type { FindSimilarParams, SearchParams, SearchResponse } from "./rpc";
import type { FindSimilarToolInput, SearchToolInput } from "./tools";

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function toSearchParams(_input: SearchToolInput): SearchParams {
  throw new Error("not implemented: agent-format.toSearchParams");
}

export function toFindSimilarParams(_input: FindSimilarToolInput): FindSimilarParams {
  throw new Error("not implemented: agent-format.toFindSimilarParams");
}

export interface AgentFormatOptions {
  maxTokens?: number;
  maxSnippetLines?: number;
}

export const DEFAULT_AGENT_FORMAT_OPTIONS: Required<AgentFormatOptions> = { maxTokens: 4000, maxSnippetLines: 12 };

export function formatForAgent(_resp: SearchResponse, _opts?: AgentFormatOptions): string {
  throw new Error("not implemented: agent-format.formatForAgent");
}
