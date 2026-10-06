import { describe, expect, it } from "vitest";
import { chunkWindows } from "./fallback";

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("chunkWindows", () => {
  it("returns nothing for empty content", () => {
    expect(chunkWindows("")).toEqual([]);
  });

  it("makes a single window for short files", () => {
    const c = chunkWindows(file(10));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ startLine: 1, endLine: 10, kind: "window", symbol: null });
  });

  it("uses 50-line windows with 10-line overlap", () => {
    const c = chunkWindows(file(120));
    expect(c.map((w) => [w.startLine, w.endLine])).toEqual([
      [1, 50],
      [41, 90],
      [81, 120],
    ]);
  });

  it("does not emit a redundant tail window", () => {
    const c = chunkWindows(file(90));
    expect(c.map((w) => [w.startLine, w.endLine])).toEqual([
      [1, 50],
      [41, 90],
    ]);
  });

  it("computes byte offsets for multi-byte text", () => {
    const content = "héllo\nwörld\nok";
    const c = chunkWindows(content, { size: 2, overlap: 1 });
    expect(c).toHaveLength(2);
    const buf = Buffer.from(content);
    for (const w of c) expect(buf.subarray(w.startByte, w.endByte).toString()).toBe(w.text);
    expect(c[1]!.startLine).toBe(2);
    expect(c[1]!.endByte).toBe(buf.length);
  });
});
