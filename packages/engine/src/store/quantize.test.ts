import { describe, expect, it } from "vitest";
import { dequantizeInt8, quantizeInt8 } from "./quantize";

describe("quantize", () => {
  it("rounds x*127 and clamps", () => {
    expect(Array.from(quantizeInt8(Float32Array.from([0, 1, -1, 0.5, 2, -3, 0.004])))).toEqual([0, 127, -127, 64, 127, -127, 1]);
  });
  it("dequantizes to x/127", () => {
    expect(Array.from(dequantizeInt8(Int8Array.from([127, -127, 0])))).toEqual([1, -1, 0]);
  });
  it("round-trips within quantization error", () => {
    const v = Float32Array.from([0.3, -0.7, 0.01]);
    const r = dequantizeInt8(quantizeInt8(v));
    v.forEach((x, i) => expect(Math.abs(r[i]! - x)).toBeLessThan(1 / 127));
  });
});
