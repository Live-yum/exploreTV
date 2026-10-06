import { boxDownsampleRgbaNative } from "./native-reducer.mjs";

/** Merge only Canvas-dependent cells, with at most one 16-pixel row readback. */
export function mergeCanvasOverviewRows(
  canvas,
  data,
  unsafe,
  width,
  height,
  x = 0,
  y = 0,
) {
  const safe = Uint8Array.from(unsafe, (value) => 1 - value);
  const ctx = canvas.getContext("2d");
  for (let row = 0; row < height; row++) {
    const start = row * width;
    let first = 0,
      last = width - 1;
    while (first < width && !unsafe[start + first]) first++;
    if (first === width) continue;
    while (!unsafe[start + last]) last--;
    const cells = last - first + 1;
    const pixels = ctx.getImageData(
      x + first * 16,
      y + row * 16,
      cells * 16,
      16,
    );
    const reduced = boxDownsampleRgbaNative(pixels.data, cells * 16, 16, 16, {
      safe,
      rgba: data,
      widthTiles: width,
      offsetX: first,
      offsetY: row,
    });
    data.set(reduced, (start + first) * 4);
  }
  return data;
}
