import type { EmbCache } from "./types";

export function openEmbCache(_path: string): EmbCache {
  throw new Error("not implemented: cache/embcache.openEmbCache");
}

export function toFloat16(_v: Float32Array): Uint16Array {
  throw new Error("not implemented: cache/embcache.toFloat16");
}

export function fromFloat16(_v: Uint16Array): Float32Array {
  throw new Error("not implemented: cache/embcache.fromFloat16");
}
