export const THRESHOLDS = {
  rssMb: { qwen: 2560, bgeM3: 1024, small: 1024 },
  statusP95Ms: 200,
  lexicalP95Ms: 200,
  nr07Ms: 1000,
  searchMaxMs: 1300,
  embedTimeoutMs: 800,
  shutdownMs: 10_000,
  defaultMinEmbedded: 300,
} as const;

export const FATAL_ERROR = /inference process exited|SIGTRAP|SIGABRT|SIGSEGV/;

export type Phase = "scanning" | "lexical" | "vector" | "idle" | "other";

export interface PsEntry {
  pid: number;
  ppid: number;
  rssKb: number;
}

export interface TreeRss {
  totalKb: number;
  rootKb: number;
  childrenKb: number;
  pids: number[];
}

export interface Latency {
  ms: number;
  indexing: boolean;
  partial?: boolean;
  partialReason?: string;
}

export interface CheckVerdict {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface VerdictInput {
  model: string;
  minEmbedded: number;
  chunks: number;
  embedded: number;
  exitedBeforeShutdown: { code: number | null; signal: string | null } | null;
  errors: string[];
  rss: { supported: boolean; peakTotalKb: number; peakRootKb: number; peakChildKb: number; rootPeakPhase: Phase | null };
  status: number[];
  lexical: Latency[];
  hybrid: Latency[];
  similar: Latency[];
  nr07Ms: number | null;
  shutdown: { exitMs: number | null; leftover: number };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))]!;
}

export function parsePs(text: string): PsEntry[] {
  const out: PsEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) });
  }
  return out;
}

export function descendants(entries: PsEntry[], rootPid: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const e of entries) {
    const list = byParent.get(e.ppid) ?? [];
    list.push(e.pid);
    byParent.set(e.ppid, list);
  }
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export function treeRss(entries: PsEntry[], rootPid: number): TreeRss {
  const byPid = new Map(entries.map((e) => [e.pid, e]));
  const kids = descendants(entries, rootPid);
  const rootKb = byPid.get(rootPid)?.rssKb ?? 0;
  const childrenKb = kids.reduce((s, pid) => s + (byPid.get(pid)?.rssKb ?? 0), 0);
  return { totalKb: rootKb + childrenKb, rootKb, childrenKb, pids: [rootPid, ...kids] };
}

export function rssLimitMb(model: string): number {
  if (model === "qwen3-embedding-0.6b") return THRESHOLDS.rssMb.qwen;
  if (model === "bge-m3") return THRESHOLDS.rssMb.bgeM3;
  return THRESHOLDS.rssMb.small;
}

const mb = (kb: number) => Math.round(kb / 1024);
const fmt = (n: number) => (Number.isNaN(n) ? "n/a" : String(Math.round(n)));

export function latencyStats(samples: number[]) {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples.length === 0 ? NaN : Math.max(...samples),
  };
}

export function searchShares(samples: Latency[]) {
  const n = samples.length;
  const timedOut = samples.filter((s) => s.partial && /timed out/.test(s.partialReason ?? "")).length;
  const semantic = samples.filter((s) => !s.partial).length;
  return { n, semanticShare: n === 0 ? 0 : semantic / n, timedOutShare: n === 0 ? 0 : timedOut / n };
}

function searchCheck(name: string, all: Latency[]): CheckVerdict {
  const samples = all.filter((s) => s.indexing);
  if (samples.length === 0) return { name, status: "skip", detail: "indexing finished before the first sample" };
  const ms = samples.map((s) => s.ms);
  const { p95, max } = latencyStats(ms);
  const slowNotTimedOut = samples.filter(
    (s) => s.ms > THRESHOLDS.embedTimeoutMs && !(s.partial && /timed out/.test(s.partialReason ?? "")),
  );
  const shares = searchShares(samples);
  const problems: string[] = [];
  if (p95 > THRESHOLDS.searchMaxMs) problems.push(`p95 ${fmt(p95)} > ${THRESHOLDS.searchMaxMs}`);
  if (max > THRESHOLDS.searchMaxMs) problems.push(`max ${fmt(max)} > ${THRESHOLDS.searchMaxMs}`);
  if (slowNotTimedOut.length > 0)
    problems.push(`${slowNotTimedOut.length} responses > ${THRESHOLDS.embedTimeoutMs} ms without partial/timed out`);
  return {
    name,
    status: problems.length === 0 ? "pass" : "fail",
    detail: `n=${samples.length} p95=${fmt(p95)} max=${fmt(max)} semantic=${(shares.semanticShare * 100).toFixed(0)}% timedOut=${(shares.timedOutShare * 100).toFixed(0)}%${problems.length ? "; " + problems.join("; ") : ""}`,
  };
}

export function evaluate(input: VerdictInput): CheckVerdict[] {
  const checks: CheckVerdict[] = [];

  const fatal = input.errors.filter((e) => FATAL_ERROR.test(e));
  const crashDetail = input.exitedBeforeShutdown
    ? `engine exited before shutdown (code=${input.exitedBeforeShutdown.code}, signal=${input.exitedBeforeShutdown.signal})`
    : fatal.length > 0
      ? `fatal errors: ${fatal.slice(0, 3).join(" | ")}`
      : "no crashes";
  checks.push({
    name: "no-crash",
    status: input.exitedBeforeShutdown || fatal.length > 0 ? "fail" : "pass",
    detail: crashDetail,
  });

  const need = Math.min(input.minEmbedded, input.chunks);
  checks.push({
    name: "progress",
    status: input.embedded >= need && input.chunks > 0 ? "pass" : "fail",
    detail: `embedded=${input.embedded} chunks=${input.chunks} required>=${need}`,
  });

  const limit = rssLimitMb(input.model);
  if (!input.rss.supported) {
    checks.push({ name: "rss", status: "skip", detail: "RSS sampling is not supported on this platform" });
  } else {
    const total = mb(input.rss.peakTotalKb);
    checks.push({
      name: "rss",
      status: total <= limit ? "pass" : "fail",
      detail: `peak tree ${total} MB (limit ${limit}); engine ${mb(input.rss.peakRootKb)} MB (peak phase ${input.rss.rootPeakPhase ?? "n/a"}), inference ${mb(input.rss.peakChildKb)} MB`,
    });
  }

  const st = latencyStats(input.status);
  checks.push({
    name: "status-p95",
    status: st.n > 0 && st.p95 <= THRESHOLDS.statusP95Ms ? "pass" : "fail",
    detail: `n=${st.n} p95=${fmt(st.p95)} max=${fmt(st.max)} (limit ${THRESHOLDS.statusP95Ms})`,
  });

  const lx = latencyStats(input.lexical.map((s) => s.ms));
  checks.push({
    name: "lexical-p95",
    status: lx.n > 0 && lx.p95 <= THRESHOLDS.lexicalP95Ms ? "pass" : "fail",
    detail: `n=${lx.n} p95=${fmt(lx.p95)} max=${fmt(lx.max)} (limit ${THRESHOLDS.lexicalP95Ms})`,
  });

  checks.push({
    name: "nr07",
    status: input.nr07Ms !== null && input.nr07Ms <= THRESHOLDS.nr07Ms ? "pass" : "fail",
    detail: input.nr07Ms === null ? "marker did not appear" : `${fmt(input.nr07Ms)} ms (limit ${THRESHOLDS.nr07Ms})`,
  });

  checks.push(searchCheck("hybrid-during-indexing", input.hybrid));
  checks.push(searchCheck("find-similar-during-indexing", input.similar));

  const { exitMs, leftover } = input.shutdown;
  checks.push({
    name: "shutdown",
    status: exitMs !== null && exitMs <= THRESHOLDS.shutdownMs && leftover === 0 ? "pass" : "fail",
    detail: `exit ${exitMs === null ? "timed out" : fmt(exitMs) + " ms"}, leftover children ${leftover}`,
  });

  return checks;
}

export function allPassed(checks: CheckVerdict[]): boolean {
  return checks.every((c) => c.status !== "fail");
}
