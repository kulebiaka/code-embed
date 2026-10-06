import type { EffectiveSettings } from "../config/types";
import type { LockHandle } from "../core/lock";
import type { IndexMeta } from "../core/meta";
import type { IndexStore } from "../store/types";

export interface OpenedIndex {
  store: IndexStore;
  meta: IndexMeta;
  indexDir: string;
  created: boolean;
  rebuildReason?: string;
  lock: LockHandle | null;
  readOnly: boolean;
}

export interface OpenIndexOptions {
  readonly?: boolean;
  expectedModelId?: string | null;
  dims?: number | null;
  requireExisting?: boolean;
}

export function openIndex(_root: string, _settings: EffectiveSettings, _opts: OpenIndexOptions): Promise<OpenedIndex> {
  throw new Error("not implemented: indexer/open.openIndex");
}
