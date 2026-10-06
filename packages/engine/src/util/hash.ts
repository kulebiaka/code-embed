import { createBLAKE3, type IHasher } from "hash-wasm";

let hasher: IHasher | null = null;
let loading: Promise<void> | null = null;

export function initHashing(): Promise<void> {
  loading ??= createBLAKE3().then(
    (h) => {
      hasher = h;
    },
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

export function blake3Hex(data: string | Uint8Array): string {
  if (!hasher) throw new Error("blake3Hex: hashing is not initialized, call initHashing() first");
  return hasher.init().update(data).digest("hex");
}
