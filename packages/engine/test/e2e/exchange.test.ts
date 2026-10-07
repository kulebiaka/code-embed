import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCli, makeEnv, makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

function findEmbDb(dir: string): string {
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === "emb.db") return join(e.parentPath, e.name);
  }
  throw new Error(`emb.db not found under ${dir}`);
}

function readVectors(file: string): Buffer[] {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT vector FROM emb").all().map((r) => Buffer.from((r as { vector: Uint8Array }).vector));
  } finally {
    db.close();
  }
}

describe("export / import (R-129)", () => {
  it("imported vectors are used by index without inference", async () => {
    expect((await sb.run(["index"])).code).toBe(0);
    const file = join(sb.base, "vectors.gz");
    const exp = await sb.run(["export", "--out", file]);
    expect(exp.code).toBe(0);
    const count = Number(/exported (\d+) vectors/.exec(exp.stdout)![1]);
    expect(count).toBeGreaterThan(0);

    const raw = gunzipSync(readFileSync(file));
    const nl = raw.indexOf(0x0a);
    const header = JSON.parse(raw.subarray(0, nl).toString("utf8"));
    expect(header).toMatchObject({ format: "code-embed-vectors", version: 1, count, dims: 64 });
    expect(typeof header.model_id).toBe("string");

    // the embedder never yields all-zero vectors, so zeros surviving `index` prove the cache was used as is
    const body = Buffer.from(raw.subarray(nl + 1));
    const rec = 32 + header.dims * 2;
    for (let i = 0; i < count; i++) body.fill(0, i * rec + 32, (i + 1) * rec);
    writeFileSync(file, gzipSync(Buffer.concat([raw.subarray(0, nl + 1), body])));

    const root2 = join(sb.base, "repo2");
    cpSync(sb.root, root2, { recursive: true });
    const cache2 = join(sb.base, "cache2");
    const opts = { cwd: root2, env: makeEnv(cache2, sb.config) };

    const imp = await execCli(["import", file], opts);
    expect(imp.code).toBe(0);
    expect(imp.stdout).toContain(`imported ${count} vectors`);

    const idx = await execCli(["index", "--full"], opts);
    expect(idx.code).toBe(0);
    expect(idx.stderr).toMatch(/vectors (\d+)\/\1/);

    const vectors = readVectors(findEmbDb(cache2));
    expect(vectors.length).toBe(count);
    expect(vectors.every((v) => v.every((b) => b === 0))).toBe(true);

    const status = JSON.parse((await execCli(["status", "--json"], opts)).stdout);
    expect(status.embedded).toBe(status.chunks);
  });

  it("import rejects a file with a mismatched model", async () => {
    expect((await sb.run(["index"])).code).toBe(0);
    const file = join(sb.base, "v.gz");
    expect((await sb.run(["export", "--out", file])).code).toBe(0);
    const raw = gunzipSync(readFileSync(file));
    const nl = raw.indexOf(0x0a);
    const header = JSON.parse(raw.subarray(0, nl).toString("utf8"));
    header.model_id = "other/model@64";
    writeFileSync(file, gzipSync(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), raw.subarray(nl + 1)])));
    const r = await sb.run(["import", file]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("model_id mismatch");
  });
});
