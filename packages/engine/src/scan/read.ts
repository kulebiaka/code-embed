import { readFile } from "node:fs/promises";
import { blake3Hex, initHashing } from "../util/hash";
import { isLockfileName } from "./scan";
import type { ScannedFile, SkipReason } from "./types";

const BINARY_PROBE_BYTES = 8192;
const MINIFIED_AVG_LINE = 300;

export async function readCandidate(
  file: ScannedFile,
): Promise<{ content: string; hash: string } | { skip: SkipReason }> {
  if (isLockfileName(file.path)) return { skip: "lockfile" };
  const data = await readFile(file.absPath);
  if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { skip: "binary" };
  const content = data.toString("utf8");
  if (content.length > 0) {
    let lines = 1;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
    if (content.length / lines > MINIFIED_AVG_LINE) return { skip: "minified" };
  }
  return { content, hash: await hashContent(data) };
}

export async function hashContent(data: Uint8Array | string): Promise<string> {
  await initHashing();
  return blake3Hex(data);
}
