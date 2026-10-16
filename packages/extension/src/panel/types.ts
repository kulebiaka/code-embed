import type { LineRange } from "@code-embed/protocol";

export interface PanelController {
  focus(): Promise<void>;
  runQuery(query: string): Promise<void>;
  findSimilar(path: string, range: LineRange, symbol?: string | null): Promise<void>;
  clear(): void;
}
