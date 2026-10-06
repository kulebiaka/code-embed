import { describe, expect, it, vi } from "vitest";
import { FakeEmbedder } from "./fake";
import { withQueryCache } from "./lru";

describe("withQueryCache", () => {
  it("caches queries and not documents", async () => {
    const f = new FakeEmbedder();
    const q = vi.spyOn(f, "embedQueries");
    const d = vi.spyOn(f, "embedDocuments");
    const c = withQueryCache(f);
    const a = await c.embedQueries(["x", "y"]);
    const b = await c.embedQueries(["y", "x", "z"]);
    expect(b[0]).toEqual(a[1]);
    expect(b[1]).toEqual(a[0]);
    expect(q).toHaveBeenCalledTimes(2);
    expect(q.mock.calls[1]![0]).toEqual(["z"]);
    await c.embedDocuments(["x"]);
    await c.embedDocuments(["x"]);
    expect(d).toHaveBeenCalledTimes(2);
    expect(c.info).toBe(f.info);
  });

  it("evicts least recently used beyond capacity", async () => {
    const f = new FakeEmbedder();
    const q = vi.spyOn(f, "embedQueries");
    const c = withQueryCache(f, 2);
    await c.embedQueries(["a"]);
    await c.embedQueries(["b"]);
    await c.embedQueries(["a"]);
    await c.embedQueries(["c"]);
    expect(q).toHaveBeenCalledTimes(3);
    await c.embedQueries(["a"]);
    expect(q).toHaveBeenCalledTimes(3);
    await c.embedQueries(["b"]);
    expect(q).toHaveBeenCalledTimes(4);
  });

  it("defaults to 1000 entries", async () => {
    const f = new FakeEmbedder();
    const q = vi.spyOn(f, "embedQueries");
    const c = withQueryCache(f);
    await c.embedQueries(Array.from({ length: 1001 }, (_, i) => `q${i}`));
    await c.embedQueries(["q1000"]);
    expect(q).toHaveBeenCalledTimes(1);
    await c.embedQueries(["q0"]);
    expect(q).toHaveBeenCalledTimes(2);
  });
});
