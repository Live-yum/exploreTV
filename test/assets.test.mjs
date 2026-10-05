import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { inspectPng } from "../core/assets.mjs";
test("PNG preflight rejects decompression bombs before image decode", () => {
  const png = new PNG({ width: 2, height: 3 });
  const bytes = PNG.sync.write(png);
  assert.deepEqual(inspectPng(bytes), {
    width: 2,
    height: 3,
    decodedBytes: 24,
  });
  const bad = Buffer.from(bytes);
  bad.writeUInt32BE(100000, 16);
  assert.throws(() => inspectPng(bad), /dimensions/);
  assert.throws(() => inspectPng(new Uint8Array(30)), /header/);
});

test("texture cache accounting includes retained encoded and raw image channels", async () => {
  const { registerTextureSource, textureMemoryBytes, textureSource } =
    await import("../core/assets.mjs");
  const image = { width: 2, height: 3 };
  const pngBytes = new Uint8Array(70),
    data = new Uint8ClampedArray(24);
  registerTextureSource(image, {
    pngBytes,
    rawRgba: { width: 2, height: 3, data },
  });
  assert.equal(textureMemoryBytes(image), 118);
  assert.equal(textureSource(image).rawRgba.data, data);
  assert.throws(
    () =>
      registerTextureSource(image, {
        pngBytes,
        rawRgba: { width: 1, height: 3, data },
      }),
    /dimensions/,
  );
});
