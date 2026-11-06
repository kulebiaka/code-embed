import { relative, resolve, sep } from "node:path";
import { formatOutlineForAgent, type EngineApi } from "@code-embed/protocol";
import { parseSearchArgs, USAGE, UsageError, type SearchFlags } from "../args";
import { withConsent } from "../consent";
import { openForCli, resolveRoot } from "../open";
import { EXIT, type CliIO, type CommandRun } from "../types";

const QUICK_UPDATE_BUDGET_MS = 2000;

export function relativeToRoot(io: CliIO, flags: SearchFlags, path: string): string {
  const root = resolveRoot(io, flags);
  const rel = relative(root, resolve(io.cwd, path)).split(sep).join("/");
  if (rel.startsWith("..")) throw new UsageError(`${path} is outside the project root ${root}`);
  return rel;
}

export async function runTool<T>(
  io: CliIO,
  flags: SearchFlags,
  call: (api: EngineApi) => Promise<T>,
  format: (res: T) => string,
): Promise<number> {
  const { opened } = await openForCli(io, flags);
  try {
    if (opened.local && !flags.noUpdate) await opened.local.quickUpdate(QUICK_UPDATE_BUDGET_MS);
    const res = await withConsent(io, opened.api, () => call(opened.api));
    if (!res) return EXIT.ERROR;
    io.stdout.write(flags.json ? `${JSON.stringify(res)}\n` : `${format(res).replace(/\n*$/, "\n")}`);
    return EXIT.OK;
  } finally {
    await opened.close();
  }
}

export function reportError(io: CliIO, err: unknown): number {
  io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof UsageError) io.stderr.write(`\n${USAGE}`);
  return EXIT.ERROR;
}

export const run: CommandRun = async (argv, io) => {
  try {
    const { flags, positionals } = parseSearchArgs(argv);
    if (positionals.length !== 1) throw new UsageError("usage: outline <PATH>");
    const path = relativeToRoot(io, flags, positionals[0]!);
    return await runTool(io, flags, (api) => api.outline({ path }), formatOutlineForAgent);
  } catch (err) {
    return reportError(io, err);
  }
};
