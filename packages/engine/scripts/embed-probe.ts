import { readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "../src/embed/catalog";
import { createLocalEmbedder } from "../src/embed/local";
import { modelsDir } from "../src/core/paths";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const BATCH = 32;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
}

function worstCase(i: number): string {
  const kind = i % 3;
  let s = "";
  if (kind === 0) {
    const cjk = "検索埋め込みモデル代码语义搜索索引向量数据库";
    while (s.length < 6000) s += cjk[(s.length * 7 + i) % cjk.length]! + (s.length % 11 === 0 ? "😀" : "");
  } else if (kind === 1) {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let x = i + 1;
    while (s.length < 8000) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      s += a[x % a.length];
    }
  } else {
    while (s.length < 7000) s += `veryLongIdentifierName${s.length}ForTokenizerStress`;
  }
  return `path: probe/worst-${i}.txt\n\n${s}`;
}

function buildTexts(n: number): string[] {
  const files: string[] = [];
  walk(join(REPO, "packages"), files);
  const pieces: string[] = [];
  for (const f of files) {
    const rel = f.slice(REPO.length);
    const src = readFileSync(f, "utf8");
    for (let o = 0; o < src.length; o += 1600) {
      pieces.push(`path: ${rel}\nlang: typescript\n\n${src.slice(o, o + 1600)}`);
    }
  }
  const out: string[] = [];
  let code = 0;
  for (let i = 0; i < n; i++) {
    if (i % 100 < 15) out.push(worstCase(i));
    else out.push(pieces[code++ % pieces.length]!);
  }
  return out;
}

async function main(): Promise<void> {
  const modelId = arg("model") ?? "qwen3-embedding-0.6b";
  const n = Number(arg("texts") ?? 512);
  const threads = Number(arg("threads") ?? Math.max(1, Math.floor(availableParallelism() / 2)));
  const budgetMb = Number(
    arg("budget-mb") ?? (modelId === "qwen3-embedding-0.6b" ? 1280 : modelId === "bge-m3" ? 1024 : 700),
  );
  const emb = createLocalEmbedder(getModel(modelId), { modelsDir: modelsDir(), threads });
  await emb.init();
  const rssAfterInitMb = Math.round(process.memoryUsage().rss / 1048576);
  const texts = buildTexts(n);
  const t0 = performance.now();
  for (let i = 0; i < texts.length; i += BATCH) {
    await emb.embedDocuments(texts.slice(i, i + BATCH));
    await emb.embedQueries(["function that reads a file from disk"]);
  }
  const seconds = (performance.now() - t0) / 1000;
  const peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  await emb.dispose();
  const ok = peakRssMb <= budgetMb;
  console.log(
    JSON.stringify({
      model: modelId,
      threads,
      texts: n,
      seconds: Math.round(seconds * 10) / 10,
      textsPerSec: Math.round((n / seconds) * 100) / 100,
      rssAfterInitMb,
      peakRssMb,
      budgetMb,
      ok,
    }),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
