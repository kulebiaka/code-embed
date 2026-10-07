import type { EvalMetrics, EvalQuery, ExpectedChunk } from "./types";

export interface Hit {
  path: string;
  startLine: number;
  endLine: number;
}

export interface QueryScore {
  query: EvalQuery;
  recall: number;
  rr: number;
}

export interface AggregateMetrics {
  overall: EvalMetrics;
  ru: EvalMetrics;
  en: EvalMetrics;
  perRepo: Record<string, EvalMetrics>;
}

export const TOP_K = 10;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function isHit(expected: ExpectedChunk, result: Hit): boolean {
  return (
    norm(expected.path) === norm(result.path) &&
    result.startLine <= expected.endLine &&
    expected.startLine <= result.endLine
  );
}

export function scoreQuery(query: EvalQuery, results: Hit[]): QueryScore {
  const top = results.slice(0, TOP_K);
  const found = query.expected.filter((e) => top.some((r) => isHit(e, r))).length;
  const first = top.findIndex((r) => query.expected.some((e) => isHit(e, r)));
  return {
    query,
    recall: query.expected.length === 0 ? 0 : found / query.expected.length,
    rr: first < 0 ? 0 : 1 / (first + 1),
  };
}

export function metricsOf(scores: QueryScore[]): EvalMetrics {
  const n = scores.length;
  if (n === 0) return { count: 0, recallAt10: 0, mrr: 0 };
  return {
    count: n,
    recallAt10: scores.reduce((s, x) => s + x.recall, 0) / n,
    mrr: scores.reduce((s, x) => s + x.rr, 0) / n,
  };
}

export function aggregate(scores: QueryScore[]): AggregateMetrics {
  const perRepo: Record<string, EvalMetrics> = {};
  for (const repo of new Set(scores.map((s) => s.query.repo))) {
    perRepo[repo] = metricsOf(scores.filter((s) => s.query.repo === repo));
  }
  return {
    overall: metricsOf(scores),
    ru: metricsOf(scores.filter((s) => s.query.lang === "ru")),
    en: metricsOf(scores.filter((s) => s.query.lang === "en")),
    perRepo,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}
