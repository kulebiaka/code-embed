export interface RunMetrics {
  toolCalls: number;
  tokens: number;
  seconds: number;
  score: number;
}

const normalize = (s: string): string => s.replaceAll("\\", "/").toLowerCase();

export function scoreAnswer(answer: string, mustMention: string[]): number {
  if (mustMention.length === 0) return 0;
  const text = normalize(answer);
  return mustMention.filter((m) => text.includes(normalize(m))).length / mustMention.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function taskValue(runs: RunMetrics[]): RunMetrics {
  return {
    toolCalls: median(runs.map((r) => r.toolCalls)),
    tokens: median(runs.map((r) => r.tokens)),
    seconds: median(runs.map((r) => r.seconds)),
    score: median(runs.map((r) => r.score)),
  };
}

export function summarize(tasks: RunMetrics[]): RunMetrics {
  return {
    toolCalls: median(tasks.map((t) => t.toolCalls)),
    tokens: median(tasks.map((t) => t.tokens)),
    seconds: median(tasks.map((t) => t.seconds)),
    score: mean(tasks.map((t) => t.score)),
  };
}
