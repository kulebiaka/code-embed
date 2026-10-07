import { relative, resolve, sep } from "node:path";
import type { FindSimilarParams } from "@code-embed/protocol";
import { parseSearchArgs, splitGlobs, USAGE, UsageError } from "../args";
import { resolveRoot } from "../open";
import { EXIT, type CliIO, type CommandRun } from "../types";
import { runQuery } from "./search";

const LOCATION = /^(.+):(\d+)-(\d+)$/;

async function readStdin(io: CliIO): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of io.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

export const run: CommandRun = async (argv, io) => {
  try {
    const { flags, positionals } = parseSearchArgs(argv);
    if (positionals.length !== 1) throw new UsageError("usage: similar <PATH>:<START>-<END> | similar -");
    const target = positionals[0]!;
    const filters = { ...splitGlobs(flags.globs), lang: flags.lang };
    let params: FindSimilarParams;

    if (target === "-") {
      const code = await readStdin(io);
      if (code.trim() === "") throw new UsageError("no code received on stdin");
      params = { code, top: flags.top, ...filters };
    } else {
      const m = LOCATION.exec(target);
      if (!m) throw new UsageError(`expected <PATH>:<START>-<END>, got "${target}"`);
      const startLine = Number(m[2]);
      const endLine = Number(m[3]);
      if (startLine < 1 || endLine < startLine) throw new UsageError(`invalid line range ${startLine}-${endLine}`);
      const root = resolveRoot(io, flags);
      const rel = relative(root, resolve(io.cwd, m[1]!)).split(sep).join("/");
      if (rel.startsWith("..")) throw new UsageError(`${m[1]} is outside the project root ${root}`);
      params = { path: rel, range: { startLine, endLine }, top: flags.top, ...filters };
    }

    return await runQuery(io, flags, (api) => api.findSimilar(params));
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof UsageError) io.stderr.write(`\n${USAGE}`);
    return EXIT.ERROR;
  }
};
