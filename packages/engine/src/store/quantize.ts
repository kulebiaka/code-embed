export function quantizeInt8(v: Float32Array): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127)));
  }
  return out;
}

export function dequantizeInt8(v: Int8Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / 127;
  return out;
}
