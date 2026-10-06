import { blake3Hex, initHashing } from "../util/hash";
import { CHUNKER_VERSION } from "./types";

export function normalizeChunkText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => l !== "")
    .join("\n");
}

export async function chunkHash(text: string): Promise<string> {
  await initHashing();
  return blake3Hex(normalizeChunkText(text) + CHUNKER_VERSION);
}
