import type { IndexStore } from "./types";

export interface OpenStoreOptions {
  readonly?: boolean;
}

export function openIndexStore(_dbPath: string, _opts?: OpenStoreOptions): IndexStore {
  throw new Error("not implemented: store/sqlite.openIndexStore");
}
