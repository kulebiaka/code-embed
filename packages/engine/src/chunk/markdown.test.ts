import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./markdown";
import type { ChunkOptions } from "./types";

const opts = (maxTokens = 400): ChunkOptions => ({ maxTokens, overlapRatio: 0.15, countTokens: (s) => Math.ceil(s.length / 4) });

const brief = (md: string, o = opts()) =>
  chunkMarkdown(md, o).map((c) => [c.symbol, c.parentSymbol, c.startLine, c.endLine]);

describe("chunkMarkdown", () => {
  it("splits ATX headings with parents", () => {
    const md = "intro\n\n# A\ntext\n## B\nb\n### C\nc\n## D\nd\n# E\ne\n";
    expect(brief(md)).toEqual([
      [null, null, 1, 1],
      ["A", null, 3, 4],
      ["B", "A", 5, 6],
      ["C", "B", 7, 8],
      ["D", "A", 9, 10],
      ["E", null, 11, 12],
    ]);
  });

  it("handles setext headings and closing hashes", () => {
    const md = "Title\n=====\nbody\n\nSub\n---\nmore\n\n## Closed ##\nx\n";
    expect(brief(md)).toEqual([
      ["Title", null, 1, 3],
      ["Sub", "Title", 5, 7],
      ["Closed", "Title", 9, 10],
    ]);
  });

  it("ignores headings in fenced code", () => {
    const md = "# Doc\n```sh\n# comment\n```\n~~~\n# also\n~~~\n";
    const c = chunkMarkdown(md, opts());
    expect(c).toHaveLength(1);
    expect(c[0]!.symbol).toBe("Doc");
    expect(c[0]!.kind).toBe("section");
  });

  it("keeps front matter out of headings", () => {
    const md = "---\ntitle: x\n# not heading\n---\n# Real\nbody\n";
    expect(brief(md)).toEqual([
      [null, null, 1, 4],
      ["Real", null, 5, 6],
    ]);
  });

  it("splits long sections with overlap", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join("\n");
    const c = chunkMarkdown(`# Big\n${body}\n`, opts(40));
    expect(c.length).toBeGreaterThan(2);
    for (const x of c) {
      expect(x.symbol).toBe("Big");
      expect(x.text.length / 4).toBeLessThanOrEqual(40 + 4);
    }
    expect(c[1]!.startLine).toBeLessThanOrEqual(c[0]!.endLine);
    expect(c[c.length - 1]!.endLine).toBe(41);
  });

  it("returns nothing for empty input", () => {
    expect(chunkMarkdown("", opts())).toEqual([]);
  });
});
