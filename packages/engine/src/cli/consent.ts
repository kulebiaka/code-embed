import { createInterface } from "node:readline";
import { ErrorCodes, type EngineApi } from "@code-embed/protocol";
import type { CliIO } from "./types";

export interface ConsentNeeded {
  host: string;
  provider?: string;
}

export function consentNeeded(err: unknown): ConsentNeeded | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { host?: unknown; provider?: unknown; code?: unknown; data?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (err.name === "ConsentRequiredError" && typeof e.host === "string") {
    return { host: e.host, provider: str(e.provider) };
  }
  if (e.code === ErrorCodes.ConsentRequired) {
    const data = e.data as { host?: unknown; provider?: unknown } | undefined;
    if (typeof data?.host === "string") return { host: data.host, provider: str(data.provider) };
  }
  return null;
}

export async function askConsent(io: CliIO, host: string): Promise<boolean> {
  io.stderr.write(`Code will be sent to ${host}. Allow? [y/N] `);
  const rl = createInterface({ input: io.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function withConsent<T>(io: CliIO, api: EngineApi, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const need = consentNeeded(err);
    if (!need) throw err;
    if (!io.isTTY) {
      io.stderr.write(
        `code-embed: code would be sent to ${need.host}; consent is required. Re-run with --allow-remote to allow it.\n`,
      );
      return null;
    }
    if (!(await askConsent(io, need.host))) {
      io.stderr.write("code-embed: consent declined\n");
      return null;
    }
    await api.grantConsent({ host: need.host });
    return await fn();
  }
}
