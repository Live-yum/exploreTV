import { open, link, unlink, stat } from "node:fs/promises";
import { createDeflate } from "node:zlib";
import { createHash } from "node:crypto";
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  table[i] = c >>> 0;
}
function crc(type, data) {
  let c = 0xffffffff;
  for (const b of type) c = table[(c ^ b) & 255] ^ (c >>> 8);
  for (const b of data) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export async function createPngWriter({
  path,
  width,
  height,
  compressionLevel = 6,
  signal,
}) {
  if (
    typeof path !== "string" ||
    !path ||
    ![width, height].every(Number.isSafeInteger) ||
    width < 1 ||
    height < 1 ||
    width > 262144 ||
    height > 131072 ||
    width * height * 4 > 32 * 1024 ** 3
  )
    throw new Error("PNG dimensions exceed streaming budget");
  if (
    !Number.isInteger(compressionLevel) ||
    compressionLevel < 0 ||
    compressionLevel > 9
  )
    throw new Error("Invalid PNG compression level");
  if (signal?.aborted) throw new Error("PNG export aborted");
  try {
    await stat(path);
    throw new Error("PNG output already exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const partial = path + ".partial",
    file = await open(partial, "wx"),
    hash = createHash("sha256");
  let rows = 0,
    bytes = 0,
    state = "open",
    busy = false,
    fatal = null;
  const raw = Buffer.allocUnsafe(width * 4 + 1),
    deflater = createDeflate({ level: compressionLevel, chunkSize: 64 * 1024 });
  async function writeAll(data) {
    let offset = 0;
    while (offset < data.length) {
      const r = await file.write(data, offset, data.length - offset);
      if (!r.bytesWritten) throw new Error("PNG output short write");
      offset += r.bytesWritten;
    }
    hash.update(data);
    bytes += data.length;
  }
  async function chunk(name, data) {
    const type = Buffer.from(name),
      header = Buffer.alloc(8),
      tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    type.copy(header, 4);
    tail.writeUInt32BE(crc(type, data));
    await writeAll(header);
    await writeAll(data);
    await writeAll(tail);
  }
  try {
    await writeAll(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    await chunk("IHDR", ihdr);
  } catch (e) {
    await file.close();
    await unlink(partial);
    throw e;
  }
  const pump = (async () => {
    for await (const data of deflater) await chunk("IDAT", data);
  })().catch((e) => {
    fatal = e;
    deflater.destroy(e);
  });
  function check() {
    if (state !== "open") throw new Error("PNG writer is " + state);
    if (signal?.aborted) throw new Error("PNG export aborted");
    if (fatal) throw fatal;
  }
  async function abort(reason) {
    if (state === "finished" || state === "aborted") return;
    state = "aborted";
    deflater.destroy();
    await pump;
    await file.close().catch(() => {});
    await unlink(partial).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async function writeRows(rgba, rowCount) {
    check();
    if (busy) throw new Error("Concurrent PNG writes are unsupported");
    if (
      !Number.isSafeInteger(rowCount) ||
      rowCount < 1 ||
      rows + rowCount > height ||
      !(rgba instanceof Uint8Array) ||
      rgba.byteLength !== rowCount * width * 4
    )
      throw new Error("Invalid PNG row count or RGBA length");
    busy = true;
    try {
      for (let y = 0; y < rowCount; y++) {
        check();
        const start = y * width * 4;
        raw[0] = 1;
        for (let i = 0; i < width * 4; i++)
          raw[i + 1] =
            (rgba[start + i] - (i < 4 ? 0 : rgba[start + i - 4])) & 255;
        // Deflate may retain its input until the callback: never reuse raw early.
        await new Promise((resolve, reject) =>
          deflater.write(raw, (e) => (e ? reject(e) : resolve())),
        );
        rows++;
      }
    } catch (e) {
      await abort(e);
      throw e;
    } finally {
      busy = false;
    }
  }
  async function finish({ beforePublish = () => {} } = {}) {
    check();
    if (busy) throw new Error("PNG write in progress");
    if (rows !== height) {
      await abort();
      throw new Error("PNG row count incomplete");
    }
    state = "finishing";
    try {
      deflater.end();
      await pump;
      if (fatal) throw fatal;
      if (signal?.aborted) throw new Error("PNG export aborted");
      await chunk("IEND", Buffer.alloc(0));
      await file.sync();
      await file.close();
      // Refuse replacing a file created by another actor while streaming.
      try {
        await stat(path);
        throw new Error("PNG output appeared during export");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await beforePublish();
      if (signal?.aborted || state === "aborted")
        throw new Error("PNG export aborted");
      if (fatal) throw fatal;
      await link(partial, path);
      await unlink(partial);
      state = "finished";
      return { path, width, height, rows, bytes, sha256: hash.digest("hex") };
    } catch (e) {
      await abort(e);
      throw e;
    }
  }
  return { writeRows, finish, abort };
}
