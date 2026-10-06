export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  required: boolean;
  status: CheckStatus;
  ms: number;
  detail?: unknown;
  error?: string;
}

export interface RuntimeInfo {
  node: string;
  platform: string;
  arch: string;
  electron?: string;
  abi?: string;
}

export interface RuntimeReport extends RuntimeInfo {
  ok: boolean;
  failedRequired: string[];
  warnings: string[];
  checks: CheckResult[];
}

export function aggregate(info: RuntimeInfo, checks: CheckResult[]): RuntimeReport {
  const failedRequired = checks.filter((c) => c.required && c.status === "fail").map((c) => c.name);
  const warnings = checks.filter((c) => c.status === "warn").map((c) => c.name);
  return { ...info, ok: failedRequired.length === 0, failedRequired, warnings, checks };
}

export function exitCode(reports: RuntimeReport[]): number {
  return reports.every((r) => r.ok) ? 0 : 1;
}

export async function runCheck(
  name: string,
  required: boolean,
  fn: () => unknown | Promise<unknown>,
): Promise<CheckResult> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    return { name, required, status: "pass", ms: Math.round(performance.now() - t0), detail };
  } catch (e) {
    return {
      name,
      required,
      status: required ? "fail" : "warn",
      ms: Math.round(performance.now() - t0),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function minVersionFromRange(range: string): string {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) throw new Error(`cannot extract a version from range "${range}"`);
  return m[0];
}

export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const last = lines[lines.length - 1];
  if (!last) throw new Error("no JSON report in output");
  return JSON.parse(last);
}
