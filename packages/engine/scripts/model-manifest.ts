import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ModelManifest } from "../src/embed/types";

const MANIFEST = fileURLToPath(new URL("../src/embed/models.json", import.meta.url));

interface TreeEntry {
  type: string;
  path: string;
  size: number;
  lfs?: { oid: string; size: number };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function hashRemote(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const h = createHash("sha256");
  for await (const chunk of res.body) h.update(chunk);
  return h.digest("hex");
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as ModelManifest;
  for (const model of manifest.models) {
    const tree = await getJson<TreeEntry[]>(
      `https://huggingface.co/api/models/${model.hfRepo}/tree/${model.revision}?recursive=true`,
    );
    const byPath = new Map(tree.filter((e) => e.type === "file").map((e) => [e.path, e]));
    let total = 0;
    for (const file of model.files) {
      const entry = byPath.get(file.path);
      if (!entry) throw new Error(`${model.id}: ${file.path} not found in ${model.hfRepo}@${model.revision}`);
      file.size = entry.lfs?.size ?? entry.size;
      file.sha256 =
        entry.lfs?.oid ??
        (await hashRemote(`https://huggingface.co/${model.hfRepo}/resolve/${model.revision}/${file.path}`));
      total += file.size;
    }
    model.sizeMb = Math.round(total / 1024 / 1024);
    process.stderr.write(`${model.id}: ${model.files.length} files, ${model.sizeMb} MB\n`);
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
