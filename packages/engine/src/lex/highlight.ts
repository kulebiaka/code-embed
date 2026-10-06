import type { Snippet } from "@code-embed/protocol";

export function buildSnippet(
  _text: string,
  _startLine: number,
  _query: string | null,
  _opts: { maxLines: number; contextLines?: number },
): Snippet {
  throw new Error("not implemented: lex/highlight.buildSnippet");
}
