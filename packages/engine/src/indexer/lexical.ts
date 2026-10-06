import type { IndexerContext, LexicalRunResult, PathChanges } from "./types";

export function runLexical(
  _ctx: IndexerContext,
  _opts?: { full?: boolean; budgetMs?: number; signal?: AbortSignal },
): Promise<LexicalRunResult> {
  throw new Error("not implemented: indexer/lexical.runLexical");
}

export function applyChanges(_ctx: IndexerContext, _changes: PathChanges): Promise<{ changedPaths: string[] }> {
  throw new Error("not implemented: indexer/lexical.applyChanges");
}
