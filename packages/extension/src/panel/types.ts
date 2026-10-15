import type { SearchResponse } from "@code-embed/protocol";

export interface PanelController {
  focus(): Promise<void>;
  runQuery(query: string): Promise<void>;
  showSimilar(title: string, resp: SearchResponse): Promise<void>;
  clear(): void;
}
