import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { fromFloat16, toFloat16 } from "./embcache";
import type { EmbCache } from "./types";

export const EXCHANGE_FORMAT_VERSION = 1;

export interface ExchangeHeader {
  format: "code-embed-vectors";
  version: number;
  model_id: string;
  dims: number;
  count: number;
}

const HASH_BYTES = 32;
const HEX_RE = /^[0-9a-f]{64}$/;

export async function exportVectors(
  cache: EmbCache,
  modelId: string,
  dims: number,
  hashes: Iterable<string>,
  outFile: string,
): Promise<{ count: number }> {
  const found = cache.get(modelId, [...new Set(hashes)]);
  const recordSize = HASH_BYTES + dims * 2;
  const records: Buffer[] = [];
  for (const [hash, vec] of found) {
    if (!HEX_RE.test(hash)) throw new Error(`invalid chunk hash: ${hash}`);
    if (vec.length !== dims) continue;
    const rec = Buffer.alloc(recordSize);
    Buffer.from(hash, "hex").copy(rec, 0);
    const h = toFloat16(vec);
    Buffer.from(h.buffer, h.byteOffset, h.byteLength).copy(rec, HASH_BYTES);
    records.push(rec);
  }
  const header: ExchangeHeader = {
    format: "code-embed-vectors",
    version: EXCHANGE_FORMAT_VERSION,
    model_id: modelId,
    dims,
    count: records.length,
  };
  const body = Buffer.concat([Buffer.from(JSON.stringify(header) + "\n", "utf8"), ...records]);
  await writeFile(outFile, gzipSync(body));
  return { count: records.length };
}

export async function importVectors(
  cache: EmbCache,
  file: string,
  expect: { modelId: string; dims: number },
): Promise<{ count: number }> {
  const raw = gunzipSync(await readFile(file));
  const nl = raw.indexOf(0x0a);
  if (nl < 0) throw new Error("invalid vectors file: missing header");
  let header: ExchangeHeader;
  try {
    header = JSON.parse(raw.subarray(0, nl).toString("utf8")) as ExchangeHeader;
  } catch {
    throw new Error("invalid vectors file: malformed header");
  }
  if (header.format !== "code-embed-vectors") throw new Error("invalid vectors file: unknown format");
  if (header.version !== EXCHANGE_FORMAT_VERSION) {
    throw new Error(`unsupported vectors file version ${header.version}`);
  }
  if (header.model_id !== expect.modelId) {
    throw new Error(`model_id mismatch: file has ${header.model_id}, expected ${expect.modelId}`);
  }
  if (header.dims !== expect.dims) {
    throw new Error(`dims mismatch: file has ${header.dims}, expected ${expect.dims}`);
  }
  const recordSize = HASH_BYTES + header.dims * 2;
  const body = raw.subarray(nl + 1);
  if (!Number.isInteger(header.count) || header.count < 0 || body.length !== header.count * recordSize) {
    throw new Error("invalid vectors file: size does not match header count");
  }
  const entries: { chunkHash: string; vector: Float32Array }[] = [];
  for (let i = 0; i < header.count; i++) {
    const off = i * recordSize;
    const u16 = new Uint16Array(header.dims);
    new Uint8Array(u16.buffer).set(body.subarray(off + HASH_BYTES, off + recordSize));
    entries.push({ chunkHash: body.subarray(off, off + HASH_BYTES).toString("hex"), vector: fromFloat16(u16) });
  }
  cache.put(expect.modelId, entries);
  return { count: entries.length };
}
