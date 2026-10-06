const PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\p{N}+|(?![\x00-\x7f])[\p{L}\p{M}]+/gu;

export interface TokenPart {
  text: string;
  start: number;
  end: number;
}

export function splitWithOffsets(token: string): TokenPart[] {
  const parts: TokenPart[] = [];
  for (const m of token.matchAll(PART)) {
    parts.push({ text: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return parts;
}

export function splitIdentifier(token: string): string[] {
  return splitWithOffsets(token).map((p) => p.text);
}
