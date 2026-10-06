import { describe, expect, it } from "vitest";
import { blake3Hex, initHashing } from "./hash";

describe("hash", () => {
  it("computes blake3 after init", async () => {
    await initHashing();
    await initHashing();
    expect(blake3Hex("")).toBe("af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    expect(blake3Hex(new TextEncoder().encode("abc"))).toBe(blake3Hex("abc"));
    expect(blake3Hex("a")).not.toBe(blake3Hex("b"));
  });
});
