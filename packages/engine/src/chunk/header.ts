import { splitIdentifier } from "../lex/split";
import type { Chunk } from "./types";

const IDENT = /[\p{L}\p{N}_$]+/gu;

function words(s: string): string[] {
  return (s.match(IDENT) ?? []).flatMap((t) => t.split(/[_$]+/)).flatMap(splitIdentifier);
}

export function buildEmbeddingText(chunk: Chunk, ctx: { path: string; lang: string | null }): string {
  const head = [`path: ${ctx.path}`];
  if (ctx.lang) head.push(`lang: ${ctx.lang}`);
  if (chunk.parentSymbol) head.push(`parent_symbol: ${chunk.parentSymbol}`);
  if (chunk.signature) head.push(`signature: ${chunk.signature}`);
  const names = [chunk.symbol, chunk.parentSymbol, chunk.signature].flatMap((s) => (s ? words(s) : []));
  if (names.length > 0) head.push(`symbols: ${names.join(" ")}`);
  return `${head.join("\n")}\n\n${chunk.text}`;
}
