import type { IndexStatus, LineRange, Range, SearchMode, SearchResponse } from "@code-embed/protocol/rpc";
import type { ClientState } from "../engine/types";

export type PanelCommand = "openSettings" | "showLog" | "index";

export type WebviewToHost =
  | { type: "ready" }
  | { type: "search"; requestId: number; query: string; mode: SearchMode; include: string[]; exclude: string[]; lang?: string; top?: number }
  | { type: "cancel"; requestId: number }
  | { type: "open"; path: string; range: Range; side?: boolean }
  | { type: "copy"; text: string }
  | { type: "similar"; path: string; range: LineRange }
  | { type: "command"; command: PanelCommand };

export type HostToWebview =
  | { type: "config"; defaultMode: SearchMode; top: number }
  | { type: "results"; requestId: number; query: string; response: SearchResponse; title?: string }
  | { type: "error"; requestId?: number; message: string }
  | { type: "status"; status: IndexStatus }
  | { type: "engine"; state: ClientState }
  | { type: "focusInput"; query?: string }
  | { type: "clear" };
