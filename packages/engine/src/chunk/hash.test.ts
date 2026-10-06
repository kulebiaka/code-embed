import { describe, expect, it } from "vitest";
import { chunkHash, normalizeChunkText } from "./hash";

describe("normalizeChunkText", () => {
  it("normalizes line endings, trailing spaces and blank lines", () => {
    expect(normalizeChunkText("a  \r\n\r\n  b\t\r\n\r\n")).toBe("a\n  b");
  });
});

describe("chunkHash", () => {
  it("is a 64-char hex blake3 digest", async () => {
    expect(await chunkHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores line-ending differences", async () => {
    expect(await chunkHash("a\nb\n")).toBe(await chunkHash("a\r\nb\r\n"));
  });

  it("differs for different text", async () => {
    expect(await chunkHash("a")).not.toBe(await chunkHash("b"));
  });
});
