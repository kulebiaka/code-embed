import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromFloat16, openEmbCache, toFloat16 } from "./embcache";
import { exportVectors, importVectors } from "./exchange";
import type { EmbCache } from "./types";

const h = (n: number) => n.toString(16).padStart(64, "0");
let dir: string;
let cache: EmbCache;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "emb-"));
  cache = openEmbCache(join(dir, "sub", "emb.db"));
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("float16", () => {
  it("handles special values", () => {
    const out = fromFloat16(toFloat16(new Float32Array([0, -0, -1, 1, Infinity, -Infinity, 1e-7, 70000])));
    expect(out[0]).toBe(0);
    expect(Object.is(out[1], -0)).toBe(true);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBe(1);
    expect(out[4]).toBe(Infinity);
    expect(out[5]).toBe(-Infinity);
    expect(out[6]).toBeGreaterThan(0);
    expect(out[6]).toBeLessThan(1.2e-7);
    expect(out[7]).toBe(Infinity);
    expect(fromFloat16(toFloat16(new Float32Array([NaN])))[0]).toBeNaN();
  });
  it("subnormal roundtrip", () => {
    const tiny = 2 ** -24;
    expect(fromFloat16(toFloat16(new Float32Array([tiny, 3 * tiny])))).toEqual(new Float32Array([tiny, 3 * tiny]));
  });
  it("roundtrip error < 1e-3 on [-1,1]", () => {
    const v = new Float32Array(2000).map((_, i) => Math.sin(i * 1.7) * Math.cos(i));
    const r = fromFloat16(toFloat16(v));
    for (let i = 0; i < v.length; i++) expect(Math.abs(r[i]! - v[i]!)).toBeLessThan(1e-3);
  });
});

describe("EmbCache", () => {
  it("put/get and model isolation", () => {
    cache.put("a", [{ chunkHash: h(1), vector: new Float32Array([0.5, -0.25]) }]);
    cache.put("b", [{ chunkHash: h(1), vector: new Float32Array([1, 1]) }]);
    expect([...cache.get("a", [h(1), h(2)]).keys()]).toEqual([h(1)]);
    expect(cache.get("a", [h(1)]).get(h(1))).toEqual(new Float32Array([0.5, -0.25]));
    expect(cache.get("b", [h(1)]).get(h(1))).toEqual(new Float32Array([1, 1]));
    expect(cache.get("c", [h(1)]).size).toBe(0);
    expect(cache.count("a")).toBe(1);
    expect(cache.count()).toBe(2);
  });
  it("handles more hashes than a batch", () => {
    const entries = Array.from({ length: 1200 }, (_, i) => ({ chunkHash: h(i), vector: new Float32Array([i % 7]) }));
    cache.put("m", entries);
    expect(cache.get("m", entries.map((e) => e.chunkHash)).size).toBe(1200);
  });
  it("gc removes stale, get refreshes last_used", async () => {
    cache.put("m", [
      { chunkHash: h(1), vector: new Float32Array([1]) },
      { chunkHash: h(2), vector: new Float32Array([1]) },
    ]);
    await new Promise((r) => setTimeout(r, 40));
    cache.get("m", [h(2)]);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.gc({ olderThanDays: 0.06 / 86400 })).toBe(1);
    expect([...cache.get("m", [h(1), h(2)]).keys()]).toEqual([h(2)]);
    expect(cache.gc({ olderThanDays: 30 })).toBe(0);
  });
});

describe("exchange", () => {
  it("roundtrips", async () => {
    cache.put("m", [
      { chunkHash: h(1), vector: new Float32Array([0.5, -0.5, 0.125]) },
      { chunkHash: h(2), vector: new Float32Array([1, 0, -1]) },
    ]);
    const file = join(dir, "v.gz");
    expect(await exportVectors(cache, "m", 3, [h(1), h(2), h(9)], file)).toEqual({ count: 2 });
    const other = openEmbCache(join(dir, "other.db"));
    expect(await importVectors(other, file, { modelId: "m", dims: 3 })).toEqual({ count: 2 });
    expect(other.get("m", [h(1)]).get(h(1))).toEqual(new Float32Array([0.5, -0.5, 0.125]));
    other.close();
  });
  it("rejects mismatch without partial write", async () => {
    cache.put("m", [{ chunkHash: h(1), vector: new Float32Array([1, 2]) }]);
    const file = join(dir, "v.gz");
    await exportVectors(cache, "m", 2, [h(1)], file);
    const other = openEmbCache(join(dir, "other.db"));
    await expect(importVectors(other, file, { modelId: "x", dims: 2 })).rejects.toThrow(/model_id/);
    await expect(importVectors(other, file, { modelId: "m", dims: 3 })).rejects.toThrow(/dims/);
    expect(other.count()).toBe(0);
    other.close();
  });
  it("rejects truncated body", async () => {
    const file = join(dir, "bad.gz");
    const header = { format: "code-embed-vectors", version: 1, model_id: "m", dims: 2, count: 2 };
    writeFileSync(file, gzipSync(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), Buffer.alloc(36)])));
    await expect(importVectors(cache, file, { modelId: "m", dims: 2 })).rejects.toThrow(/size/);
    expect(cache.count()).toBe(0);
  });
});
