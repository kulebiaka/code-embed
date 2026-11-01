import type { ReferencesParams, ReferencesResponse } from "@code-embed/protocol";
import type { IndexStore } from "../store/types";

export function findReferences(_store: IndexStore, _p: ReferencesParams): ReferencesResponse {
  throw new Error("not implemented: findReferences");
}
