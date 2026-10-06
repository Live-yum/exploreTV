import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { createPngWriter } from "../scripts/png-stream.mjs";
test("streamed PNG roundtrips odd-width rows and multiple bands with correct digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "png-stream-"));
  try {
    const width = 259,
      height = 37,
      data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 73 + (i >>> 8)) & 255;
    const path = join(dir, "out.png"),
      w = await createPngWriter({ path, width, height });
    for (let y = 0; y < height; y += 7) {
      const n = Math.min(7, height - y);
      await w.writeRows(data.subarray(y * width * 4, (y + n) * width * 4), n);
    }
    const result = await w.finish(),
      bytes = await readFile(path),
      png = PNG.sync.read(bytes);
    assert.equal(png.width, width);
    assert.equal(png.height, height);
    assert.deepEqual(png.data, data);
    assert.equal(result.rows, height);
    assert.equal(result.bytes, bytes.length);
    assert.equal(
      result.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    await assert.rejects(w.finish());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("streamed PNG validates bounds, incomplete rows, abort and existing output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "png-stream-"));
  try {
    const path = join(dir, "out.png");
    await assert.rejects(createPngWriter({ path, width: 0, height: 2 }));
    const w = await createPngWriter({ path, width: 3, height: 2 });
    await assert.rejects(w.writeRows(new Uint8Array(12), 3));
    await w.writeRows(new Uint8Array(12), 1);
    await assert.rejects(w.finish(), /incomplete/);
    await assert.rejects(stat(path + ".partial"));
    const c = new AbortController(),
      b = await createPngWriter({
        path,
        width: 3,
        height: 2,
        signal: c.signal,
      });
    c.abort();
    await assert.rejects(b.writeRows(new Uint8Array(12), 1), /aborted/);
    await b.abort();
    await b.abort();
    await assert.rejects(stat(path + ".partial"));
    await writeFile(path, "keep");
    await assert.rejects(
      createPngWriter({ path, width: 1, height: 1 }),
      /exists/,
    );
    assert.equal(await readFile(path, "utf8"), "keep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PNG streaming supports the real-world width without a giant canvas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "png-wide-"));
  try {
    const width = 134400,
      height = 2,
      data = Buffer.alloc(width * height * 4);
    for (let x = 0; x < width; x++) {
      data.set([x & 255, (x >>> 8) & 255, 23, 255], x * 4);
      data.set([61, x & 255, 122, 255], (width + x) * 4);
    }
    const path = join(dir, "wide.png"),
      writer = await createPngWriter({ path, width, height });
    await writer.writeRows(data, height);
    await writer.finish();
    const result = PNG.sync.read(await readFile(path));
    assert.equal(result.width, width);
    assert.deepEqual(result.data, data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation during the final publication hook never publishes a PNG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "png-final-cancel-"));
  try {
    const path = join(dir, "out.png"),
      controller = new AbortController();
    const writer = await createPngWriter({
      path,
      width: 1,
      height: 1,
      signal: controller.signal,
    });
    await writer.writeRows(Buffer.from([1, 2, 3, 255]), 1);
    await assert.rejects(
      writer.finish({ beforePublish: async () => controller.abort() }),
      /abort/i,
    );
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(stat(path + ".partial"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
