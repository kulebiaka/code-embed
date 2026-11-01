import type { OutlineParams, OutlineResponse } from "@code-embed/protocol";
import type { IndexStore } from "../store/types";

export function outline(_store: IndexStore, _p: OutlineParams): OutlineResponse {
  throw new Error("not implemented: outline");
}
