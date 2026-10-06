import type { IndexStatus, Range, SearchMode, SearchResponse } from "@code-embed/protocol/rpc";

export type WebviewToHost =
  | { type: "ready" }
  | { type: "search"; requestId: number; query: string; mode: SearchMode; include: string[]; exclude: string[]; lang?: string }
  | { type: "cancel"; requestId: number }
  | { type: "open"; path: string; range: Range };

export type HostToWebview =
  | { type: "config"; defaultMode: SearchMode; top: number }
  | { type: "results"; requestId: number; query: string; response: SearchResponse; title?: string }
  | { type: "error"; requestId?: number; message: string }
  | { type: "status"; status: IndexStatus }
  | { type: "focusInput"; query?: string };
