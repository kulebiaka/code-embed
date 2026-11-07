export interface EvalRepo {
  name: string;
  url: string;
  commit: string;
  languages: string[];
  license: string;
}

export interface ExpectedChunk {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ExpectedContextChunk {
  path: string;
  symbol: string;
}

export interface EvalContext {
  path: string;
  line: number;
  expected: ExpectedContextChunk[];
}

export interface EvalQuery {
  id: string;
  repo: string;
  query: string;
  lang: "ru" | "en";
  expected: ExpectedChunk[];
  context?: EvalContext;
  tags?: string[];
}

export interface EvalMetrics {
  count: number;
  recallAt10: number;
  mrr: number;
}

export interface ContextMetrics {
  count: number;
  recall: number;
}

export type EvalMode = "lexical" | "semantic" | "hybrid";

export interface EvalReport {
  model: string;
  mode: EvalMode;
  createdAt: string;
  overall: EvalMetrics;
  ru: EvalMetrics;
  en: EvalMetrics;
  perRepo: Record<string, EvalMetrics>;
  contextRecall?: ContextMetrics;
  indexSeconds?: number;
  chunksPerSec?: number;
  rssMb?: number;
}
