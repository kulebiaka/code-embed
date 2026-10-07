import { parseArgs } from "node:util";
import type { SearchMode } from "@code-embed/protocol";

export class UsageError extends Error {
  override name = "UsageError";
}

export type ColorMode = "auto" | "always" | "never";

export interface SearchFlags {
  mode?: SearchMode;
  top?: number;
  globs: string[];
  lang?: string;
  threshold?: number;
  context: number;
  filesOnly: boolean;
  json: boolean;
  noUpdate: boolean;
  root?: string;
  color: ColorMode;
  provider?: string;
  model?: string;
  allowRemote: boolean;
  help: boolean;
  version: boolean;
}

export interface ParsedSearch {
  flags: SearchFlags;
  positionals: string[];
}

const OPTIONS = {
  semantic: { type: "boolean", short: "s" },
  lexical: { type: "boolean", short: "l" },
  hybrid: { type: "boolean", short: "H" },
  top: { type: "string", short: "n" },
  glob: { type: "string", short: "g", multiple: true },
  lang: { type: "string" },
  threshold: { type: "string" },
  context: { type: "string", short: "C" },
  "files-only": { type: "boolean" },
  json: { type: "boolean" },
  "no-update": { type: "boolean" },
  root: { type: "string" },
  color: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  "allow-remote": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

function intOption(name: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < min) {
    throw new UsageError(`--${name} expects an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

export function parseSearchArgs(argv: string[]): ParsedSearch {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;

  const modes: SearchMode[] = [];
  if (v.semantic) modes.push("semantic");
  if (v.lexical) modes.push("lexical");
  if (v.hybrid) modes.push("hybrid");
  if (modes.length > 1) throw new UsageError("--semantic, --lexical and --hybrid are mutually exclusive");

  const color = v.color ?? "auto";
  if (color !== "auto" && color !== "always" && color !== "never") {
    throw new UsageError(`--color expects auto, always or never, got "${color}"`);
  }

  let threshold: number | undefined;
  if (v.threshold !== undefined) {
    threshold = Number(v.threshold);
    if (v.threshold.trim() === "" || !Number.isFinite(threshold)) {
      throw new UsageError(`--threshold expects a number, got "${v.threshold}"`);
    }
  }

  return {
    positionals: parsed.positionals,
    flags: {
      mode: modes[0],
      top: intOption("top", v.top, 1),
      globs: v.glob ?? [],
      lang: v.lang,
      threshold,
      context: intOption("context", v.context, 0) ?? 0,
      filesOnly: v["files-only"] ?? false,
      json: v.json ?? false,
      noUpdate: v["no-update"] ?? false,
      root: v.root,
      color,
      provider: v.provider,
      model: v.model,
      allowRemote: v["allow-remote"] ?? false,
      help: v.help ?? false,
      version: v.version ?? false,
    },
  };
}

export function splitGlobs(globs: string[]): { include?: string[]; exclude?: string[] } {
  const include = globs.filter((g) => !g.startsWith("!"));
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

export const USAGE = `Usage:
  code-embed [OPTIONS] <QUERY>
  code-embed similar <PATH>:<START>-<END> [OPTIONS]
  code-embed similar - [--lang ts] [OPTIONS]
  code-embed index [--watch] [--full]
  code-embed status | stop | gc | clean
  code-embed daemon [--detach]
  code-embed mcp [--root DIR]
  code-embed model install [--from FILE] | model list
  code-embed provider list | add | test <name>
  code-embed export [--out FILE] | import <FILE>

Search options:
  -s, --semantic        semantic search only
  -l, --lexical         lexical search only
  -H, --hybrid          hybrid search (default)
  -n, --top N           number of results
  -g, --glob PATTERN    path glob, repeatable; prefix with ! to exclude
      --lang LANG       restrict to a language
      --threshold X     minimum score
  -C, --context N       lines of context around the match
      --files-only      print unique paths only
      --json            JSON lines output
      --no-update       do not refresh the index before searching
      --root DIR        project root
      --color WHEN      auto, always or never
      --provider NAME   embedding provider
      --model ID        embedding model
      --allow-remote    allow sending code to an external provider
  -h, --help            show this help
  -V, --version         show version
`;
