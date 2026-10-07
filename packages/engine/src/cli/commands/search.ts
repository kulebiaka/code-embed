import type { EngineApi, SearchMode, SearchResponse } from "@code-embed/protocol";
import { parseSearchArgs, splitGlobs, USAGE, UsageError, type SearchFlags } from "../args";
import { withConsent } from "../consent";
import { openForCli } from "../open";
import { renderResults, useColor } from "../output";
import { EXIT, type CliIO, type CommandRun } from "../types";

const QUICK_UPDATE_BUDGET_MS = 2000;

export async function runQuery(
  io: CliIO,
  flags: SearchFlags,
  call: (api: EngineApi, root: string) => Promise<SearchResponse>,
): Promise<number> {
  const { root, opened } = await openForCli(io, flags);
  try {
    if (opened.local && !flags.noUpdate) {
      const { complete } = await opened.local.quickUpdate(QUICK_UPDATE_BUDGET_MS);
      if (!complete) {
        io.stderr.write(
          `code-embed: index update did not finish within ${QUICK_UPDATE_BUDGET_MS / 1000}s; searching the existing index\n`,
        );
      }
    }
    const res = await withConsent(io, opened.api, () => call(opened.api, root));
    if (!res) return EXIT.ERROR;
    if (res.partial && flags.mode !== "lexical") {
      io.stderr.write(
        `code-embed: ${res.partialReason ?? "semantic index is not ready"}; results may be incomplete (run \`code-embed index\` to build vectors)\n`,
      );
    }
    io.stdout.write(
      renderResults(res.results, {
        json: flags.json,
        filesOnly: flags.filesOnly,
        context: flags.context,
        color: useColor(flags.color, io),
      }),
    );
    return res.results.length > 0 ? EXIT.OK : EXIT.NO_RESULTS;
  } finally {
    await opened.close();
  }
}

export const run: CommandRun = async (argv, io) => {
  try {
    const { flags, positionals } = parseSearchArgs(argv);
    if (positionals.length === 0) throw new UsageError("missing <QUERY>");
    const query = positionals.join(" ");
    const mode: SearchMode | undefined = flags.mode;
    return await runQuery(io, flags, (api) =>
      api.search({
        query,
        mode,
        top: flags.top,
        threshold: flags.threshold,
        lang: flags.lang,
        ...splitGlobs(flags.globs),
      }),
    );
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof UsageError) io.stderr.write(`\n${USAGE}`);
    return EXIT.ERROR;
  }
};
