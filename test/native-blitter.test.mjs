import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  clearOpaque,
  composeInto,
  composeIntoMasked,
  nativeBlitterStatus,
  nativeFrameWithOpacity,
  premultiplyRgba,
  prepareFramePixels,
  quantizeCanvasOpacity,
} from "../scripts/native-blitter.mjs";

function surface(width, height, pixels) {
  const canvas = createCanvas(width, height),
    context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas;
}

function equalBytes(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  let errors = 0;
  const examples = [];
  for (let i = 0; i < actual.length; i++)
    if (actual[i] !== expected[i]) {
      errors++;
      if (examples.length < 5) examples.push([i, actual[i], expected[i]]);
    }
  assert.equal(errors, 0, `${message}: ${JSON.stringify(examples)}`);
}

function draw(context, canvas, descriptor, opacity = 1) {
  const [, width, height, dx, dy, flipX, flipY, blend] = descriptor;
  context.save();
  context.imageSmoothingEnabled = false;
  context.globalAlpha = opacity;
  context.globalCompositeOperation = blend ? "lighter" : "source-over";
  if (flipX || flipY) {
    context.translate(dx + (flipX ? width : 0), dy + (flipY ? height : 0));
    context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  }
  context.drawImage(
    canvas,
    0,
    0,
    width,
    height,
    flipX || flipY ? 0 : dx,
    flipX || flipY ? 0 : dy,
    width,
    height,
  );
  context.restore();
}

test("prepared Canvas readback retains exact premultiplied bytes for every alpha/color pair", () => {
  const width = 256,
    height = 256;
  const straight = new Uint8Array(width * height * 4);
  for (let alpha = 0; alpha < 256; alpha++)
    for (let color = 0; color < 256; color++)
      straight.set(
        [color, 255 - color, (color * 17) % 256, alpha],
        (alpha * width + color) * 4,
      );
  const source = surface(width, height, straight);
  const premultiplied = premultiplyRgba(straight);
  equalBytes(
    prepareFramePixels(source),
    premultiplied,
    "readback/re-premultiplication",
  );
  for (let i = 0; i < straight.length; i += 4)
    for (let c = 0; c < 3; c++)
      assert.equal(
        premultiplied[i + c],
        Math.round((straight[i + c] * straight[i + 3]) / 255),
      );
  const inPlace = new Uint8ClampedArray(straight);
  assert.equal(premultiplyRgba(inPlace, inPlace), inPlace);
  equalBytes(inPlace, premultiplied, "in-place premultiplication");
});

test("source-over and additive match Skia for every alpha/destination pair", () => {
  const width = 256,
    height = 256;
  const sourceBytes = new Uint8Array(width * height * 4);
  const destination = new Uint8Array(sourceBytes.length);
  for (let alpha = 0; alpha < 256; alpha++)
    for (let color = 0; color < 256; color++) {
      const i = (alpha * width + color) * 4;
      sourceBytes.set([37, 203, (color * 31) % 256, alpha], i);
      destination.set([color, 255 - color, (color * 97) % 256, 255], i);
    }
  const source = surface(width, height, sourceBytes);
  const canvas = surface(width, height, destination),
    context = canvas.getContext("2d");
  const frames = [prepareFramePixels(source)];
  for (const blend of [0, 0, 1, 0, 1]) {
    const descriptor = Int32Array.of(0, width, height, 0, 0, 0, 0, blend);
    assert.equal(
      composeInto(destination, width, height, descriptor, frames),
      destination,
    );
    draw(context, source, descriptor);
    equalBytes(
      destination,
      context.getImageData(0, 0, width, height).data,
      `Skia blend ${blend}`,
    );
  }
});

test("opacity baking matches direct Skia blending across every source alpha/color pair", () => {
  const width = 256,
    height = 256;
  const sourceBytes = new Uint8Array(width * height * 4);
  const background = new Uint8Array(sourceBytes.length);
  for (let alpha = 0; alpha < 256; alpha++)
    for (let color = 0; color < 256; color++) {
      const i = (alpha * width + color) * 4;
      sourceBytes.set(
        [color, (color * 53 + alpha * 7) % 256, 255 - color, alpha],
        i,
      );
      background.set(
        [(color * 43 + alpha * 17) % 256, 255 - color, (color * 97) % 256, 255],
        i,
      );
    }
  const source = surface(width, height, sourceBytes),
    pm = prepareFramePixels(source);
  const saved = new Uint8Array(pm);
  const canvas = surface(width, height, background),
    context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  image.data.set(background);
  for (const opacity of [
    0,
    1,
    0.5,
    0.6,
    0.8,
    0.75,
    0.2,
    0.4,
    1 / 3,
    254 / 255,
    0.1,
    0.01,
    0.99,
    0.003,
    0.501,
    0.499,
    0.1234567,
  ]) {
    const baked = nativeFrameWithOpacity(pm, opacity);
    equalBytes(
      baked,
      prepareFramePixels(source, opacity),
      `prepared opacity ${opacity}`,
    );
    const inPlace = new Uint8Array(pm);
    assert.equal(nativeFrameWithOpacity(inPlace, opacity, inPlace), inPlace);
    equalBytes(baked, inPlace, `in-place opacity ${opacity}`);
    for (const blend of [0, 1]) {
      context.putImageData(image, 0, 0);
      const destination = new Uint8Array(background);
      const descriptor = Int32Array.of(0, width, height, 0, 0, 0, 0, blend);
      composeInto(destination, width, height, descriptor, [baked]);
      draw(context, source, descriptor, opacity);
      equalBytes(
        destination,
        context.getImageData(0, 0, width, height).data,
        `Skia opacity ${opacity}, blend ${blend}`,
      );
    }
  }
  equalBytes(pm, saved, "opacity baking preserves the shared original frame");
});

test("opacity quantization preserves Skia float32 half-byte thresholds", () => {
  const opacities = [];
  for (let q = 0; q < 255; q++)
    for (const epsilon of [-1e-8, -1e-9, -1e-15, 0, 1e-15, 1e-9, 1e-8])
      opacities.push((q + 0.5) / 255 + epsilon);
  const source = surface(1, 1, Uint8Array.of(255, 255, 255, 255));
  const canvas = createCanvas(opacities.length, 1),
    context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, 1);
  for (let i = 0; i < opacities.length; i++)
    draw(context, source, [0, 1, 1, i, 0, 0, 0, 0], opacities[i]);
  const pixels = context.getImageData(0, 0, canvas.width, 1).data;
  for (let i = 0; i < opacities.length; i++)
    assert.equal(
      quantizeCanvasOpacity(opacities[i]),
      pixels[i * 4],
      `opacity ${opacities[i]}`,
    );
  assert.equal(quantizeCanvasOpacity(128.5 / 255), 129);
  for (const invalid of [-0.001, 1.001, NaN, Infinity, "0.5", null, undefined])
    assert.throws(() => quantizeCanvasOpacity(invalid));
});

test("all effective opacity bytes preserve sequential flipped source-over/additive draws", () => {
  let seed = 0x4385bb12;
  const random = (max) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  const width = 47,
    height = 43;
  const destination = new Uint8Array(width * height * 4);
  for (let i = 0; i < destination.length; i += 4)
    destination.set([random(256), random(256), random(256), 255], i);
  const canvas = surface(width, height, destination),
    context = canvas.getContext("2d");
  const canvases = [],
    originalFrames = [];
  for (let f = 0; f < 27; f++) {
    const fw = 1 + random(17),
      fh = 1 + random(13);
    const straight = Uint8Array.from({ length: fw * fh * 4 }, () =>
      random(256),
    );
    canvases.push(surface(fw, fh, straight));
    originalFrames.push(prepareFramePixels(canvases.at(-1)));
  }
  for (let i = 0; i < 512; i++) {
    const f = random(canvases.length),
      source = canvases[f];
    const opacity = (i % 256) / 255;
    const descriptor = Int32Array.of(
      0,
      source.width,
      source.height,
      random(width + 20) - 10,
      random(height + 20) - 10,
      (i >> 1) & 1,
      i & 1,
      random(2),
    );
    composeInto(destination, width, height, descriptor, [
      nativeFrameWithOpacity(originalFrames[f], opacity),
    ]);
    draw(context, source, descriptor, opacity);
    equalBytes(
      destination,
      context.getImageData(0, 0, width, height).data,
      `sequential opacity draw ${i}`,
    );
  }
});

test("SIMD rows match Skia with unaligned buffers, flipped lanes, and scalar tails", () => {
  const width = 19,
    height = 7;
  for (const fw of [
    1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65,
  ]) {
    const fh = 3,
      straight = new Uint8Array(fw * fh * 4);
    for (let i = 0; i < straight.length; i++)
      straight[i] = (i * 43 + (i % 7) * 19) % 256;
    const source = surface(fw, fh, straight);
    const frame = new Uint8Array(
      new ArrayBuffer(straight.length + 7),
      3,
      straight.length,
    );
    frame.set(prepareFramePixels(source));
    for (let flips = 0; flips < 4; flips++)
      for (const blend of [0, 1]) {
        const destination = new Uint8Array(
          new ArrayBuffer(width * height * 4 + 7),
          1,
          width * height * 4,
        );
        for (let i = 0; i < destination.length; i += 4)
          destination.set([73, 41, 103, 255], i);
        const canvas = surface(width, height, destination),
          context = canvas.getContext("2d");
        const descriptor = Int32Array.of(
          0,
          fw,
          fh,
          flips & 1 ? -2 : 1,
          2,
          flips & 1,
          flips >> 1,
          blend,
        );
        composeInto(destination, width, height, descriptor, [frame]);
        draw(context, source, descriptor);
        equalBytes(
          destination,
          context.getImageData(0, 0, width, height).data,
          `unaligned width ${fw}, flips ${flips}, blend ${blend}`,
        );
      }
  }
});

test("ordered batches, integer flips, clipped edges, and transparent texels match Skia", () => {
  let seed = 0x8ad115;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const width = 67,
    height = 53;
  const destination = new Uint8Array(width * height * 4);
  for (let i = 0; i < destination.length; i += 4)
    destination.set([random(256), random(256), random(256), 255], i);
  const canvas = surface(width, height, destination),
    context = canvas.getContext("2d");
  const canvases = [],
    frames = [],
    descriptors = [];
  for (let f = 0; f < 13; f++) {
    const fw = 3 + random(18),
      fh = 3 + random(18);
    const pixels = Uint8Array.from({ length: fw * fh * 4 }, () => random(256));
    // Include all-opaque and all-transparent frames, and non-power-of-two widths.
    if (f < 2)
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = f ? 255 : 0;
    canvases.push(surface(fw, fh, pixels));
    frames.push(prepareFramePixels(canvases.at(-1)));
  }
  for (let i = 0; i < 240; i++) {
    const f = random(frames.length),
      source = canvases[f];
    const descriptor = [
      f,
      source.width,
      source.height,
      random(width + 20) - 10,
      random(height + 20) - 10,
      random(2),
      random(2),
      random(5) === 0 ? 1 : 0,
    ];
    descriptors.push(...descriptor);
    draw(context, source, descriptor);
  }
  // Preserve output between independent batches, as the streaming exporter does.
  for (let start = 0; start < descriptors.length; start += 37 * 8)
    composeInto(
      destination,
      width,
      height,
      Int32Array.from(descriptors.slice(start, start + 37 * 8)),
      frames,
    );
  equalBytes(
    destination,
    context.getImageData(0, 0, width, height).data,
    "random ordered composition",
  );
});

test("opaque clear, empty batches, and extreme offscreen coordinates are bounded", () => {
  const destination = new Uint8Array(8 * 7 * 4).fill(127);
  assert.equal(clearOpaque(destination), destination);
  const expected = new Uint8Array(destination);
  for (let i = 0; i < destination.length; i += 4)
    assert.deepEqual([...destination.subarray(i, i + 4)], [0, 0, 0, 255]);
  composeInto(destination, 8, 7, new Int32Array(), []);
  const frame = Uint8Array.of(255, 0, 0, 255);
  for (const dx of [-2147483648, 2147483647])
    for (const dy of [-2147483648, 2147483647])
      composeInto(destination, 8, 7, Int32Array.of(0, 1, 1, dx, dy, 1, 1, 0), [
        frame,
      ]);
  equalBytes(destination, expected, "offscreen commands");
});

test("opaque SIMD clear preserves bytes outside every unaligned view and scalar tail", () => {
  for (const Bytes of [Uint8Array, Uint8ClampedArray])
    for (let offset = 0; offset < 16; offset++)
      for (const count of [
        0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 63, 64, 65, 255,
      ]) {
        const start = 16 + offset,
          length = count * 4;
        const backing = new Uint8Array(start + length + 16).fill(0xa5);
        const view = new Bytes(backing.buffer, start, length);
        assert.equal(clearOpaque(view), view);
        for (let i = 0; i < backing.length; i++) {
          const expected =
            i < start || i >= start + length
              ? 0xa5
              : (i - start) % 4 === 3
                ? 255
                : 0;
          assert.equal(
            backing[i],
            expected,
            `offset ${offset}, count ${count}, byte ${i}`,
          );
        }
      }
});

test("the largest scene batch permits a base and additive blit for every command", () => {
  const count = 262144,
    target = clearOpaque(new Uint8Array(4));
  const descriptors = new Int32Array(count * 8);
  for (let i = 0; i < descriptors.length; i += 8) {
    descriptors[i + 1] = 1;
    descriptors[i + 2] = 1;
    descriptors[i + 7] = (i / 8) % 2;
  }
  composeInto(target, 1, 1, descriptors, [Uint8Array.of(17, 29, 43, 255)]);
  assert.deepEqual([...target], [34, 58, 86, 255]);
  assert.throws(() =>
    composeInto(target, 1, 1, new Int32Array((count + 1) * 8), []),
  );
});

test("malformed batches are rejected before changing any output byte", () => {
  const target = clearOpaque(new Uint8Array(8 * 7 * 4));
  const saved = new Uint8Array(target);
  const frame = Uint8Array.of(255, 0, 0, 255);
  const valid = [0, 1, 1, 0, 0, 0, 0, 0];
  const bad = [
    [1, 1, 1, 0, 0, 0, 0, 0],
    [0, 2, 1, 0, 0, 0, 0, 0],
    [0, -1, 1, 0, 0, 0, 0, 0],
    [0, 2147483647, 2147483647, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 2, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 2],
  ];
  for (const descriptor of bad)
    assert.throws(() =>
      composeInto(target, 8, 7, Int32Array.from([...valid, ...descriptor]), [
        frame,
      ]),
    );
  assert.throws(() =>
    composeInto(target, 9, 7, Int32Array.from(valid), [frame]),
  );
  assert.throws(() => composeInto(target, 8, 7, new Int32Array(7), [frame]));
  assert.throws(() =>
    composeInto(target, 8, 7, Int32Array.from(valid), [target.subarray(0, 4)]),
  );
  assert.throws(() =>
    composeInto(target, 8, 7, new Int32Array(target.buffer, 0, 8), [frame]),
  );
  assert.throws(() =>
    composeInto(target, 8, 7, Int32Array.from(valid), new Array(1)),
  );
  equalBytes(target, saved, "invalid batches are atomic");
  assert.throws(() => premultiplyRgba(new Uint8Array(3)));
  assert.throws(() =>
    premultiplyRgba(target.subarray(0, 8), target.subarray(4, 12)),
  );
  assert.throws(() => clearOpaque(new Uint8Array(3)));
  assert.throws(() => nativeFrameWithOpacity(new Uint8Array(3), 0.5));
  assert.throws(() =>
    nativeFrameWithOpacity(target.subarray(0, 8), 0.5, target.subarray(4, 12)),
  );
  assert.throws(() => nativeFrameWithOpacity(frame, NaN));
});

test("frame accessors cannot detach a buffer after validation", () => {
  const target = clearOpaque(new Uint8Array(4));
  const frames = [new Uint8Array(4)];
  Object.defineProperty(frames, 0, {
    get() {
      structuredClone(target.buffer, { transfer: [target.buffer] });
      return Uint8Array.of(0, 0, 0, 0);
    },
  });
  assert.throws(() =>
    composeInto(target, 1, 1, Int32Array.of(0, 1, 1, 0, 0, 0, 0, 0), frames),
  );
});

test("shared buffers are rejected to avoid concurrent descriptor mutation", () => {
  const target = clearOpaque(new Uint8Array(4));
  const descriptors = new Int32Array(new SharedArrayBuffer(32));
  descriptors.set([0, 1, 1, 0, 0, 0, 0, 0]);
  assert.throws(() =>
    composeInto(target, 1, 1, descriptors, [new Uint8Array(4)]),
  );
  assert.throws(() =>
    composeInto(target, 1, 1, Int32Array.of(0, 1, 1, 0, 0, 0, 0, 0), [
      new Uint8Array(new SharedArrayBuffer(4)),
    ]),
  );
});

test("native availability is explicit and the module has an offline fallback", () => {
  assert.equal(typeof nativeBlitterStatus.available, "boolean");
  assert.equal(
    nativeBlitterStatus.backend,
    nativeBlitterStatus.available ? "node-api" : "javascript",
  );
  assert.ok(
    ["sse2", "scalar", "javascript"].includes(nativeBlitterStatus.kernel),
  );
});

test("resolved-cell masks preserve ordered flipped planes outside exact 16px fragments", () => {
  const width = 53,
    height = 37,
    target = new Uint8Array(new ArrayBuffer(width * height * 4 + 5), 5),
    maskWidth = Math.ceil(width / 16),
    maskHeight = Math.ceil(height / 16),
    mask = new Uint8Array(new ArrayBuffer(maskWidth * maskHeight + 3), 3),
    frame = new Uint8Array(new ArrayBuffer(32 * 32 * 4 + 7), 7);
  for (let i = 0; i < target.length; i++)
    target[i] = i % 4 === 3 ? 255 : (i * 37) % 256;
  for (let i = 0; i < frame.length; i++) frame[i] = (i * 19 + 7) % 256;
  for (let i = 0; i < mask.length; i++) mask[i] = i % 3;
  const before = new Uint8Array(target),
    expected = new Uint8Array(target),
    descriptors = Int32Array.from([
      0, 32, 32, 8, 8, 0, 0, 0, 0, 32, 32, 8, 8, 1, 1, 1, 0, 32, 32, -8, -8, 1,
      0, 0, 0, 32, 32, 37, 19, 0, 1, 0, 0, 32, 32, -2147483648, 0, 0, 0, 0, 0,
      32, 32, 2147483647, 0, 0, 0, 0,
    ]);
  composeInto(expected, width, height, descriptors, [frame]);
  let pixelsSkipped = 0,
    pixelsToResolvedCells = 0;
  for (let i = 0; i < descriptors.length; i += 8) {
    const dx = descriptors[i + 3],
      dy = descriptors[i + 4];
    for (let y = Math.max(0, dy); y < Math.min(height, dy + 32); y++)
      for (let x = Math.max(0, dx); x < Math.min(width, dx + 32); x++) {
        const cell = mask[(y >> 4) * maskWidth + (x >> 4)];
        if (cell) pixelsSkipped++;
        if (cell === 1) pixelsToResolvedCells++;
      }
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[(y >> 4) * maskWidth + (x >> 4)]) {
        const at = (y * width + x) * 4;
        expected.set(before.subarray(at, at + 4), at);
      }
  assert.deepEqual(
    composeIntoMasked(target, width, height, descriptors, [frame], mask),
    { pixelsSkipped, pixelsToResolvedCells },
  );
  assert.ok(pixelsSkipped > pixelsToResolvedCells);
  assert.ok(pixelsToResolvedCells > 0);
  equalBytes(target, expected, "masked ordered planes");
});

test("resolved-cell mask validation is atomic across aliases, detachment, shared buffers and bad batches", () => {
  const target = clearOpaque(new Uint8Array(32 * 16 * 4)),
    saved = new Uint8Array(target),
    frame = Uint8Array.of(255, 0, 0, 255),
    descriptors = Int32Array.of(0, 1, 1, 0, 0, 0, 0, 0);
  for (const mask of [
    null,
    new Uint8Array(1),
    new Uint16Array(2),
    target.subarray(0, 2),
    new Uint8Array(new SharedArrayBuffer(2)),
  ])
    assert.throws(() =>
      composeIntoMasked(target, 32, 16, descriptors, [frame], mask),
    );
  const invalid = Int32Array.from([...descriptors, 4, 1, 1, 0, 0, 0, 0, 0]);
  assert.throws(() =>
    composeIntoMasked(target, 32, 16, invalid, [frame], new Uint8Array(2)),
  );
  const mask = new Uint8Array(2),
    frames = [];
  Object.defineProperty(frames, 0, {
    get() {
      structuredClone(mask.buffer, { transfer: [mask.buffer] });
      return frame;
    },
  });
  assert.throws(() =>
    composeIntoMasked(target, 32, 16, descriptors, frames, mask),
  );
  equalBytes(target, saved, "invalid masks must preserve all output bytes");
  assert.deepEqual(
    composeIntoMasked(target, 32, 16, new Int32Array(), [], new Uint8Array(2)),
    { pixelsSkipped: 0, pixelsToResolvedCells: 0 },
  );
});


test("mask prechecks and merged spans preserve wide, clipped, flipped planes", () => {
  const width = 111, height = 59, maskWidth = Math.ceil(width / 16),
    sourceWidth = 96, sourceHeight = 48,
    frame = new Uint8Array(sourceWidth * sourceHeight * 4),
    initial = new Uint8Array(width * height * 4),
    descriptors = Int32Array.from([
      0, sourceWidth, sourceHeight, -9, 5, 1, 0, 0,
      0, sourceWidth, sourceHeight, 23, -7, 0, 1, 1,
      0, sourceWidth, sourceHeight, 5, 17, 1, 1, 0,
    ]);
  for (let i = 0; i < frame.length; i++) frame[i] = (i * 29 + 43) % 256;
  for (let i = 0; i < initial.length; i++) initial[i] = i % 4 === 3 ? 255 : (i * 7 + 19) % 256;
  for (const pattern of ["empty", "island", "stripes", "full"]) {
    const mask = new Uint8Array(maskWidth * Math.ceil(height / 16));
    if (pattern === "island") { mask[maskWidth + 3] = 1; mask[maskWidth * 2 + 3] = 2; }
    if (pattern === "stripes") for (let y = 0; y < Math.ceil(height / 16); y++) { mask[y * maskWidth + 1] = 1; mask[y * maskWidth + 5] = 2; }
    if (pattern === "full") mask.fill(1);
    const actual = new Uint8Array(initial), expected = new Uint8Array(initial);
    composeInto(expected, width, height, descriptors, [frame]);
    let pixelsSkipped = 0, pixelsToResolvedCells = 0;
    for (let i = 0; i < descriptors.length; i += 8) {
      const dx = descriptors[i + 3], dy = descriptors[i + 4];
      for (let y = Math.max(0, dy); y < Math.min(height, dy + sourceHeight); y++)
        for (let x = Math.max(0, dx); x < Math.min(width, dx + sourceWidth); x++) {
          const cell = mask[(y >> 4) * maskWidth + (x >> 4)];
          if (cell) pixelsSkipped++;
          if (cell === 1) pixelsToResolvedCells++;
        }
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      if (mask[(y >> 4) * maskWidth + (x >> 4)]) {
        const at = (y * width + x) * 4;
        expected.set(initial.subarray(at, at + 4), at);
      }
    assert.deepEqual(composeIntoMasked(actual, width, height, descriptors, [frame], mask),
      {pixelsSkipped, pixelsToResolvedCells}, pattern);
    equalBytes(actual, expected, `merged ${pattern} spans`);
  }
});
