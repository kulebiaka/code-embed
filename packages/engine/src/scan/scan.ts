import type { ScanOptions, ScannedFile } from "./types";

export function scanFiles(_root: string, _opts: ScanOptions): AsyncIterable<ScannedFile> {
  throw new Error("not implemented: scan/scan.scanFiles");
}

export function createIgnoreMatcher(
  _root: string,
  _exclude: string[],
): Promise<(relPath: string, isDir: boolean) => boolean> {
  throw new Error("not implemented: scan/scan.createIgnoreMatcher");
}
