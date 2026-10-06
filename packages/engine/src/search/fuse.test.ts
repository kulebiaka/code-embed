import { describe, expect, it } from "vitest";
import { rrfFuse } from "./fuse";

describe("rrfFuse", () => {
  it("sums weight/(k+rank) and merges sources", () => {
    const r = rrfFuse([
      { ids: [1, 2], weight: 0.7, source: "lexical" },
      { ids: [2, 3], weight: 0.3, source: "semantic" },
    ]);
    expect(r.map((x) => x.id)).toEqual([2, 1, 3]);
    expect(r[0]!.score).toBeCloseTo(0.7 / 62 + 0.3 / 61, 12);
    expect(r[0]!.sources).toEqual(["lexical", "semantic"]);
    expect(r[1]!.score).toBeCloseTo(0.7 / 61, 12);
    expect(r[2]!.sources).toEqual(["semantic"]);
  });

  it("honours custom k and empty input", () => {
    expect(rrfFuse([{ ids: [5], weight: 1, source: "lexical" }], 10)[0]!.score).toBeCloseTo(1 / 11, 12);
    expect(rrfFuse([])).toEqual([]);
  });
});
