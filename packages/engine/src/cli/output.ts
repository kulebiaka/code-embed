import type { SearchResult } from "@code-embed/protocol";
import type { ColorMode } from "./args";
import type { CliIO } from "./types";

export function useColor(mode: ColorMode, io: CliIO): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return io.stdoutIsTTY && !io.env.NO_COLOR;
}

const paint = (on: boolean, code: string, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

function highlight(text: string, hit: { start: number; end: number } | undefined, color: boolean): string {
  if (!color || !hit || hit.start >= text.length) return text;
  const end = Math.min(hit.end, text.length);
  return text.slice(0, hit.start) + paint(true, "1;31", text.slice(hit.start, end)) + text.slice(end);
}

export function formatText(results: SearchResult[], opts: { context: number; color: boolean }): string {
  const { context, color } = opts;
  if (results.length === 0) return "";
  const blocks = results.map((r) => {
    const lines = r.snippet.text.split("\n");
    const hit = r.snippet.highlights[0];
    const idx = Math.min(hit?.line ?? 0, lines.length - 1);
    const col = (hit?.start ?? 0) + 1;
    const path = paint(color, "35", r.path);
    const num = (n: number) => paint(color, "32", String(n));
    const from = Math.max(0, idx - context);
    const to = Math.min(lines.length - 1, idx + context);
    const out: string[] = [];
    for (let i = from; i <= to; i++) {
      const lineNo = r.snippet.startLine + i;
      const text = lines[i]!.trimEnd();
      out.push(
        i === idx
          ? `${path}:${num(lineNo)}:${col}: ${highlight(text, hit, color)}`
          : `${path}-${num(lineNo)}- ${text}`,
      );
    }
    return out.join("\n");
  });
  return blocks.join(context > 0 ? "\n--\n" : "\n") + "\n";
}

export function formatFilesOnly(results: SearchResult[], color: boolean): string {
  return [...new Set(results.map((r) => r.path))].map((p) => paint(color, "35", p) + "\n").join("");
}

export function formatJsonLines(results: SearchResult[]): string {
  return results
    .map(
      (r) =>
        JSON.stringify({
          path: r.path,
          start_line: r.range.startLine,
          end_line: r.range.endLine,
          symbol: r.symbol,
          kind: r.kind,
          score: r.score,
          sources: r.sources,
          snippet: r.snippet.text,
        }) + "\n",
    )
    .join("");
}

export function renderResults(
  results: SearchResult[],
  opts: { json: boolean; filesOnly: boolean; context: number; color: boolean },
): string {
  if (opts.json) return formatJsonLines(results);
  if (opts.filesOnly) return formatFilesOnly(results, opts.color);
  return formatText(results, opts);
}
