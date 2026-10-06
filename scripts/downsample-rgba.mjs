/** Exact integer area reduction of a composited RGBA8 region.
 * Every source pixel contributes. Premultiplied-alpha accumulation prevents
 * transparent RGB from contaminating edges. Input blocks align to world tiles,
 * so reducing separate cores is identical to reducing the assembled image.
 */
export function boxDownsampleRgba(data, width, height, factor) {
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(factor) ||
    factor < 1 ||
    factor > 16 ||
    width % factor ||
    height % factor ||
    data.length !== width * height * 4
  )
    throw new Error("Invalid RGBA area-reduction dimensions");
  const outWidth = width / factor,
    outHeight = height / factor;
  const result = Buffer.allocUnsafe(outWidth * outHeight * 4);
  const samples = factor * factor;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = y * factor; sy < (y + 1) * factor; sy++) {
        let i = (sy * width + x * factor) * 4;
        for (let sx = 0; sx < factor; sx++, i += 4) {
          const alpha = data[i + 3];
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * outWidth + x) * 4;
      result[o] = a ? Math.round(r / a) : 0;
      result[o + 1] = a ? Math.round(g / a) : 0;
      result[o + 2] = a ? Math.round(b / a) : 0;
      result[o + 3] = Math.round(a / samples);
    }
  }
  return result;
}
