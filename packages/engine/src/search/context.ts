import type { ContextParams, ContextResponse } from "@code-embed/protocol";
import type { SearchContext } from "./types";

export interface ContextEnv extends SearchContext {
  root: string;
}

export async function buildContext(_env: ContextEnv, _p: ContextParams, _signal?: AbortSignal): Promise<ContextResponse> {
  throw new Error("not implemented: buildContext");
}
