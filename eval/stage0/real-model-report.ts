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

export interface EngineObs {
  chunks: number;
  embedded: number;
  exitedBeforeShutdown: { code: number | null; signal: string | null } | null;
  errors: string[];
  rss: { peakTreeKb: number; peakEngineKb: number; peakChildKb: number; peakPhase: Phase | null };
  status: number[];
  lexical: Latency[];
  hybrid: Latency[];
  similar: Latency[];
  nr07Ms: number | null;
  shutdown: { exitMs: number | null; leftover: number };
}

export interface HostObs {
  firstPid: number;
  pid: number;
  peakTreeKb: number;
  shutdown: { exitMs: number | null; leftover: number };
}

export interface MachineInput {
  model: string;
  minEmbedded: number;
  rssSupported: boolean;
  engines: EngineObs[];
  host: HostObs | null;
}

export interface RssSplit {
  host: TreeRss | null;
  engines: TreeRss[];
}

export interface RssPeaks {
  totalKb: number;
  hostKb: number;
  hostPids: number[];
  hostFirstPid: number | null;
  hostPid: number | null;
  engines: { treeKb: number; engineKb: number; childKb: number; phase: Phase | null }[];
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

export function splitRss(entries: PsEntry[], enginePids: number[], hostPid: number | null): RssSplit {
  const present = hostPid !== null && entries.some((e) => e.pid === hostPid);
  const host = present ? treeRss(entries, hostPid) : null;
  const hostSet = new Set(host?.pids ?? []);
  const byPid = new Map(entries.map((e) => [e.pid, e]));
  const engines = enginePids.map((pid) => {
    const tree = treeRss(entries, pid);
    const pids = tree.pids.filter((p) => !hostSet.has(p));
    const childrenKb = pids.reduce((sum, p) => (p === pid ? sum : sum + (byPid.get(p)?.rssKb ?? 0)), 0);
    return { totalKb: tree.rootKb + childrenKb, rootKb: tree.rootKb, childrenKb, pids };
  });
  return { host, engines };
}

export function newPeaks(engines: number): RssPeaks {
  return {
    totalKb: 0,
    hostKb: 0,
    hostPids: [],
    hostFirstPid: null,
    hostPid: null,
    engines: Array.from({ length: engines }, () => ({ treeKb: 0, engineKb: 0, childKb: 0, phase: null as Phase | null })),
  };
}

export function recordSample(peaks: RssPeaks, split: RssSplit, hostPid: number | null, phases: (Phase | null)[]): void {
  const total = (split.host?.totalKb ?? 0) + split.engines.reduce((s, t) => s + t.totalKb, 0);
  if (total > peaks.totalKb) peaks.totalKb = total;
  if (split.host && hostPid !== null) {
    if (peaks.hostFirstPid === null) peaks.hostFirstPid = hostPid;
    peaks.hostPid = hostPid;
    peaks.hostPids = split.host.pids;
    if (split.host.totalKb > peaks.hostKb) peaks.hostKb = split.host.totalKb;
  }
  split.engines.forEach((tree, i) => {
    const p = peaks.engines[i]!;
    if (tree.totalKb > p.treeKb) p.treeKb = tree.totalKb;
    if (tree.rootKb > p.engineKb) {
      p.engineKb = tree.rootKb;
      p.phase = phases[i] ?? null;
    }
    if (tree.childrenKb > p.childKb) p.childKb = tree.childrenKb;
  });
}

// ps -A -o pid=,command=; only processes started from this run's cli.js, so a real VS Code window's engine is never touched
export function strayInference(psText: string, cli: string): number[] {
  const out: number[] = [];
  for (const line of psText.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.includes(cli) && /\s__embed-(host|worker)(\s|$)/.test(m[2]!)) out.push(Number(m[1]));
  }
  return out;
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

function engineChecks(e: EngineObs, minEmbedded: number, prefix: string, restart: string | null): CheckVerdict[] {
  const checks: CheckVerdict[] = [];
  const fatal = e.errors.filter((x) => FATAL_ERROR.test(x));
  const problems: string[] = [];
  if (e.exitedBeforeShutdown)
    problems.push(`engine exited before shutdown (code=${e.exitedBeforeShutdown.code}, signal=${e.exitedBeforeShutdown.signal})`);
  else if (fatal.length > 0) problems.push(`fatal errors: ${fatal.slice(0, 3).join(" | ")}`);
  if (restart) problems.push(restart);
  checks.push({
    name: `${prefix}no-crash`,
    status: problems.length > 0 ? "fail" : "pass",
    detail: problems.length > 0 ? problems.join("; ") : "no crashes",
  });

  const need = Math.min(minEmbedded, e.chunks);
  checks.push({
    name: `${prefix}progress`,
    status: e.embedded >= need && e.chunks > 0 ? "pass" : "fail",
    detail: `embedded=${e.embedded} chunks=${e.chunks} required>=${need}`,
  });

  const st = latencyStats(e.status);
  checks.push({
    name: `${prefix}status-p95`,
    status: st.n > 0 && st.p95 <= THRESHOLDS.statusP95Ms ? "pass" : "fail",
    detail: `n=${st.n} p95=${fmt(st.p95)} max=${fmt(st.max)} (limit ${THRESHOLDS.statusP95Ms})`,
  });

  const lx = latencyStats(e.lexical.map((s) => s.ms));
  checks.push({
    name: `${prefix}lexical-p95`,
    status: lx.n > 0 && lx.p95 <= THRESHOLDS.lexicalP95Ms ? "pass" : "fail",
    detail: `n=${lx.n} p95=${fmt(lx.p95)} max=${fmt(lx.max)} (limit ${THRESHOLDS.lexicalP95Ms})`,
  });

  checks.push({
    name: `${prefix}nr07`,
    status: e.nr07Ms !== null && e.nr07Ms <= THRESHOLDS.nr07Ms ? "pass" : "fail",
    detail: e.nr07Ms === null ? "marker did not appear" : `${fmt(e.nr07Ms)} ms (limit ${THRESHOLDS.nr07Ms})`,
  });

  checks.push(searchCheck(`${prefix}hybrid-during-indexing`, e.hybrid));
  checks.push(searchCheck(`${prefix}find-similar-during-indexing`, e.similar));

  const { exitMs, leftover } = e.shutdown;
  checks.push({
    name: `${prefix}shutdown`,
    status: exitMs !== null && exitMs <= THRESHOLDS.shutdownMs && leftover === 0 ? "pass" : "fail",
    detail: `exit ${exitMs === null ? "timed out" : fmt(exitMs) + " ms"}, leftover children ${leftover} (shared host excluded)`,
  });
  return checks;
}

export function evaluate(input: MachineInput): CheckVerdict[] {
  const { engines, host } = input;
  const n = engines.length;
  const multi = n > 1;
  const checks: CheckVerdict[] = [];
  const restart = host && host.pid !== host.firstPid ? `host restarted: ${host.firstPid} → ${host.pid}` : null;

  if (multi && restart) checks.push({ name: "no-crash", status: "fail", detail: restart });
  engines.forEach((e, i) => {
    checks.push(...engineChecks(e, input.minEmbedded, multi ? `p${i + 1}:` : "", multi ? null : restart));
  });

  const limit = rssLimitMb(input.model);
  if (!input.rssSupported) {
    checks.push({ name: "rss", status: "skip", detail: "RSS sampling is not supported on this platform" });
    checks.push({ name: "rss-host", status: "skip", detail: "RSS sampling is not supported on this platform" });
  } else {
    const hostKb = host?.peakTreeKb ?? 0;
    if (!multi) {
      const e = engines[0]!;
      const total = mb(hostKb + e.rss.peakTreeKb);
      checks.push({
        name: "rss",
        status: total <= limit ? "pass" : "fail",
        detail: `host ${mb(hostKb)} MB + engine tree ${mb(e.rss.peakTreeKb)} MB = ${total} MB (limit ${limit}); engine ${mb(e.rss.peakEngineKb)} MB (peak phase ${e.rss.peakPhase ?? "n/a"}), inference ${mb(e.rss.peakChildKb)} MB`,
      });
    } else {
      const sum = engines.reduce((s, e) => s + e.rss.peakTreeKb, 0);
      const maxEngine = Math.max(...engines.map((e) => e.rss.peakEngineKb));
      const lhs = mb(hostKb + sum);
      const rhs = limit + n * mb(maxEngine);
      checks.push({
        name: "rss",
        status: lhs <= rhs ? "pass" : "fail",
        detail: `host ${mb(hostKb)} MB + engines [${engines.map((e) => mb(e.rss.peakTreeKb)).join(" + ")}] MB = ${lhs} MB (limit ${limit} + ${n} x max engine ${mb(maxEngine)} MB = ${rhs})`,
      });
    }
    checks.push(
      host
        ? {
            name: "rss-host",
            status: mb(host.peakTreeKb) <= limit ? "pass" : "fail",
            detail: `host tree ${mb(host.peakTreeKb)} MB (limit ${limit})`,
          }
        : { name: "rss-host", status: "skip", detail: "no shared host observed" },
    );
  }

  if (host) {
    const { exitMs, leftover } = host.shutdown;
    checks.push({
      name: "shutdown-host",
      status: exitMs !== null && exitMs <= THRESHOLDS.shutdownMs && leftover === 0 ? "pass" : "fail",
      detail: `host and inference exit after SIGTERM ${exitMs === null ? "timed out" : fmt(exitMs) + " ms"}, still alive ${leftover}`,
    });
  } else {
    checks.push({ name: "shutdown-host", status: "skip", detail: "no shared host observed" });
  }

  return checks;
}

export function allPassed(checks: CheckVerdict[]): boolean {
  return checks.every((c) => c.status !== "fail");
}
