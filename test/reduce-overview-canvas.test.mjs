import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
import { mergeCanvasOverviewRows } from "../scripts/reduce-overview-canvas.mjs";

test("Canvas merge reads bounded rows and preserves every native-only output cell", () => {
  const width = 11,
    height = 7,
    x = 13,
    y = 9;
  const canvas = createCanvas(width * 16 + x + 3, height * 16 + y + 5);
  const ctx = canvas.getContext("2d");
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4)
    pixels.data.set(
      [(i * 17 + 3) % 256, (i * 29 + 5) % 256, (i * 37 + 7) % 256, 255],
      i,
    );
  ctx.putImageData(pixels, 0, 0);
  const reference = boxDownsampleRgba(
    ctx.getImageData(x, y, width * 16, height * 16).data,
    width * 16,
    height * 16,
    16,
  );
  const reads = [];
  const tracedCanvas = {
    getContext: () => ({
      getImageData: (...args) => {
        reads.push(args);
        return ctx.getImageData(...args);
      },
    }),
  };
  for (let seed = 0; seed < 20; seed++) {
    reads.length = 0;
    const unsafe = Uint8Array.from({ length: width * height }, (_, i) =>
      seed === 0 ? 0 : seed === 1 ? 1 : +(i % seed === 1),
    );
    const data = Buffer.alloc(width * height * 4, 47);
    const expected = Buffer.from(data);
    for (let i = 0; i < unsafe.length; i++)
      if (unsafe[i]) reference.copy(expected, i * 4, i * 4, i * 4 + 4);
    assert.equal(
      mergeCanvasOverviewRows(tracedCanvas, data, unsafe, width, height, x, y),
      data,
    );
    assert.deepEqual(data, expected);
    assert.ok(reads.length <= height);
    for (const [rx, ry, rw, rh] of reads) {
      assert.equal(rh, 16);
      assert.ok(rw <= width * 16);
      assert.equal((rx - x) % 16, 0);
      assert.equal((ry - y) % 16, 0);
    }
  }
});
