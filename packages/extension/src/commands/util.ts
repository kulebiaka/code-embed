import { execFile } from "node:child_process";
import type * as vscode from "vscode";
import type { LineRange } from "@code-embed/protocol";

export const MIN_NODE = [22, 13] as const;

export function parseNodeVersion(out: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(out.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function nodeVersionOk(out: string): boolean {
  const v = parseNodeVersion(out);
  if (!v) return false;
  return v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]);
}

export function installCommand(version: string): string {
  return `npm i -g code-embed@${version}`;
}

export function mcpConfigJson(version: string, root: string): string {
  return JSON.stringify(
    { mcpServers: { "code-embed": { command: "npx", args: ["-y", `code-embed@${version}`, "mcp", "--root", root] } } },
    null,
    2,
  );
}

// 1-based inclusive; a selection ending at column 0 of a later line does not include that line.
export function selectionLineRange(sel: Pick<vscode.Selection, "start" | "end" | "isEmpty">): LineRange {
  const startLine = sel.start.line + 1;
  let endLine = sel.end.line + 1;
  if (!sel.isEmpty && sel.end.character === 0 && sel.end.line > sel.start.line) endLine -= 1;
  return { startLine, endLine };
}

export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, shell: process.platform === "win32" }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}
