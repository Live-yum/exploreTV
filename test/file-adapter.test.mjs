import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { inspectPng } from "../core/assets.mjs";
import { LIMITS } from "../core/world.mjs";
function h5Adapter(Image, mockURL) {
  let source = readFileSync(
    new URL("../adapters/files.js", import.meta.url),
    "utf8",
  );
  let keep = true;
  source = source
    .split("\n")
    .filter((line) => {
      if (line.includes("// #ifdef")) {
        keep = line.includes("H5");
        return false;
      }
      if (line.includes("// #endif")) {
        keep = true;
        return false;
      }
      return keep && !line.startsWith("import ");
    })
    .join("\n")
    .replaceAll("export ", "");
  return new Function(
    "Image",
    "URL",
    "inspectPng",
    "LIMITS",
    source + ";return {loadTexture};",
  )(Image, mockURL, inspectPng, LIMITS);
}
test("failed image decodes and synchronous image errors release every H5 Blob URL", async () => {
  const png = PNG.sync.write(new PNG({ width: 2, height: 3 })),
    file = {
      size: png.length,
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  for (const sync of [false, true]) {
    let created = 0,
      revoked = 0;
    const api = h5Adapter(
      class {
        set src(v) {
          if (sync) throw new Error("sync");
          queueMicrotask(() => this.onerror?.());
        }
      },
      {
        createObjectURL() {
          created++;
          return "blob:test";
        },
        revokeObjectURL() {
          revoked++;
        },
      },
    );
    for (let i = 0; i < 3; i++)
      await assert.rejects(() => api.loadTexture(file, null));
    assert.equal(created, 3);
    assert.equal(revoked, 3);
  }
});
