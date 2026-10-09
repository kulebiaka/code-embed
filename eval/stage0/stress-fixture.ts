import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git", ".code-embed", "reports", ".repos", "coverage"]);

export const STRESS_MARKERS = ["stressMarkerCjk", "stressMarkerBase64", "stressMarkerHuge"] as const;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function cjkMarkdown(): string {
  const rnd = lcg(1);
  const words = ["検索", "埋め込み", "索引", "代码", "语义搜索", "向量", "함수", "인덱스", "🚀", "🔍", "✨", "データ", "テスト"];
  const parts = ["# Стресс: CJK и emoji stressMarkerCjk\n"];
  let size = 0;
  for (let section = 0; size < 50_000; section++) {
    const lines = [`\n## 章節 ${section} ${words[Math.floor(rnd() * words.length)]}\n`];
    for (let p = 0; p < 4; p++) {
      let line = "";
      for (let i = 0; i < 60; i++) line += words[Math.floor(rnd() * words.length)] + (rnd() < 0.2 ? "、" : "");
      lines.push(line + "。\n");
    }
    const text = lines.join("");
    size += Buffer.byteLength(text);
    parts.push(text);
  }
  return parts.join("");
}

function base64Literals(): string {
  const rnd = lcg(2);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lines = ["export const stressMarkerBase64 = ["];
  for (let i = 0; i < 160; i++) {
    let s = "";
    for (let j = 0; j < 260; j++) s += alphabet[Math.floor(rnd() * 64)];
    lines.push(`  "${s}",`);
  }
  lines.push("];", "");
  return lines.join("\n");
}

function hugeFunction(): string {
  const lines = ["export function stressMarkerHuge(input: number): number {", "  let total = input;"];
  for (let i = 0; i < 2996; i++) lines.push(`  total = (total * ${(i % 7) + 2} + ${i}) % 1000003; // step ${i}`);
  lines.push("  return total;", "}", "");
  return lines.join("\n");
}

function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    if (SKIP.has(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else cpSync(from, to);
  }
}

export function createStressFixture(dest: string): { stressFiles: string[] } {
  for (const pkg of readdirSync(join(repoRoot, "packages")).sort()) {
    copyDir(join(repoRoot, "packages", pkg, "src"), join(dest, "packages", pkg, "src"));
  }
  copyDir(join(repoRoot, "eval", "src"), join(dest, "eval", "src"));
  copyDir(join(repoRoot, "docs"), join(dest, "docs"));
  cpSync(join(repoRoot, "README.md"), join(dest, "README.md"));

  const stress = join(dest, "stress");
  mkdirSync(stress, { recursive: true });
  const files: Record<string, string> = {
    "cjk-emoji.md": cjkMarkdown(),
    "base64-literals.ts": base64Literals(),
    "huge-function.ts": hugeFunction(),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(stress, name), content);
  return { stressFiles: Object.keys(files).map((n) => `stress/${n}`) };
}

export function copyRepoFixture(src: string, dest: string): void {
  copyDir(src, dest);
}
