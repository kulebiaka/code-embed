import type { ScannedFile, SkipReason } from "./types";

export function readCandidate(_file: ScannedFile): Promise<{ content: string; hash: string } | { skip: SkipReason }> {
  throw new Error("not implemented: scan/read.readCandidate");
}

export function hashContent(_data: Uint8Array | string): Promise<string> {
  throw new Error("not implemented: scan/read.hashContent");
}
