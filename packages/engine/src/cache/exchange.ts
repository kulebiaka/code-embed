import type { EmbCache } from "./types";

export const EXCHANGE_FORMAT_VERSION = 1;

export interface ExchangeHeader {
  format: "code-embed-vectors";
  version: number;
  model_id: string;
  dims: number;
  count: number;
}

export function exportVectors(
  _cache: EmbCache,
  _modelId: string,
  _dims: number,
  _hashes: Iterable<string>,
  _outFile: string,
): Promise<{ count: number }> {
  throw new Error("not implemented: cache/exchange.exportVectors");
}

export function importVectors(
  _cache: EmbCache,
  _file: string,
  _expect: { modelId: string; dims: number },
): Promise<{ count: number }> {
  throw new Error("not implemented: cache/exchange.importVectors");
}
