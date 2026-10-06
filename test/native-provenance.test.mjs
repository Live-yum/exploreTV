import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const hash = (data) => createHash("sha256").update(data).digest("hex");

function fixture(t, name, scalar = false) {
  const temporaryRoot = join(projectRoot, "artifacts", "test-tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, "native-provenance-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const modulePath = join(root, "scripts", `${name}.mjs`);
  const sourcePath = join(root, "scripts", `${name}.c`);
  const binaryName = `${name}-${process.platform}-${process.arch}${scalar ? "-scalar" : ""}.node`;
  const binaryPath = join(root, "artifacts", "native", binaryName);
  mkdirSync(dirname(modulePath), { recursive: true });
  mkdirSync(dirname(binaryPath), { recursive: true });
  for (const file of [`${name}.mjs`, `${name}.c`, "downsample-rgba.mjs"])
    copyFileSync(
      join(projectRoot, "scripts", file),
      join(root, "scripts", file),
    );
  const preparedBinary = join(projectRoot, "artifacts", "native", binaryName);
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(preparedBinary + ".json", "utf8"));
  } catch {
    // Tamper rejection must remain testable when optional native builds are absent.
  }
  const binary = existsSync(preparedBinary)
    ? readFileSync(preparedBinary)
    : Buffer.from("unprepared native build fixture");
  const sourceSha256 = hash(readFileSync(sourcePath));
  const prepared = !!(
    receipt?.version === 2 &&
    receipt.sourceSha256 === sourceSha256 &&
    receipt.binarySha256 === hash(binary) &&
    receipt.platform === process.platform &&
    receipt.arch === process.arch
  );
  if (!prepared)
    receipt = {
      version: 2,
      sourceSha256,
      binarySha256: hash(binary),
      platform: process.platform,
      arch: process.arch,
      napiVersion: 8,
      compiler: "test-only",
      flags: [],
      ...(name === "native-blitter" ? { forceScalar: scalar } : {}),
    };
  writeFileSync(binaryPath, binary);
  writeFileSync(binaryPath + ".json", JSON.stringify(receipt));
  const load = () => {
    const statusExport =
      name === "native-blitter" ? "nativeBlitterStatus" : "nativeReducerStatus";
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { ${statusExport} as status } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      console.log(JSON.stringify(status));
    `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EXPLORETV_DISABLE_NATIVE_BLITTER: "0",
          EXPLORETV_DISABLE_NATIVE_REDUCER: "0",
          EXPLORETV_SCALAR_BLITTER: scalar ? "1" : "0",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  return {
    binaryPath,
    binary,
    sourcePath,
    sourceSha256,
    receipt,
    prepared,
    load,
  };
}

for (const name of ["native-reducer", "native-blitter"]) {
  test(`${name} reports hashes of its verified source and executed binary`, (t) => {
    const f = fixture(t, name);
    if (!f.prepared) return t.skip("optional native build is not prepared");
    const status = f.load();
    assert.equal(status.available, true, status.reason);
    assert.equal(status.sourceSha256, f.sourceSha256);
    assert.equal(status.binarySha256, hash(f.binary));
    assert.equal(status.binarySha256, f.receipt.binarySha256);
    assert.equal(status.build.compiler, f.receipt.compiler);
    assert.deepEqual(status.build.flags, f.receipt.flags);
    assert.equal(status.build.napiVersion, 8);
    if (name === "native-blitter")
      assert.ok(["sse2", "scalar"].includes(status.kernel));
  });

  test(`${name} rejects changed binary bytes and falsified binary receipts before loading`, (t) => {
    const f = fixture(t, name);
    // An appended byte usually leaves a shared library loadable. Its receipt
    // still must reject it: successful require() alone is insufficient evidence.
    appendFileSync(f.binaryPath, Buffer.from([0]));
    const changedBinary = f.load();
    assert.equal(changedBinary.available, false);
    assert.match(changedBinary.reason, /binary hash differs/);
    assert.equal(changedBinary.sourceSha256, null);
    assert.equal(changedBinary.binarySha256, null);
    assert.equal(changedBinary.build, null);
    if (name === "native-blitter")
      assert.equal(changedBinary.kernel, "javascript");
    writeFileSync(f.binaryPath, f.binary);
    writeFileSync(
      f.binaryPath + ".json",
      JSON.stringify({
        ...f.receipt,
        binarySha256: "0".repeat(64),
      }),
    );
    const changedReceipt = f.load();
    assert.equal(changedReceipt.available, false);
    assert.match(changedReceipt.reason, /binary hash differs/);
    assert.equal(changedReceipt.binarySha256, null);
  });

  test(`${name} rejects changed source and legacy receipts without binary provenance`, (t) => {
    const f = fixture(t, name);
    appendFileSync(
      f.sourcePath,
      "\n/* changed after this binary was compiled */\n",
    );
    const changedSource = f.load();
    assert.equal(changedSource.available, false);
    assert.match(changedSource.reason, /build is stale/);
    writeFileSync(
      f.binaryPath + ".json",
      JSON.stringify({
        ...f.receipt,
        version: 1,
        sourceSha256: hash(readFileSync(f.sourcePath)),
      }),
    );
    const legacy = f.load();
    assert.equal(legacy.available, false);
    assert.match(legacy.reason, /build is stale/);
    assert.equal(legacy.binarySha256, null);
  });
}

test("the scalar blitter reports the selected binary and its actual scalar kernel", (t) => {
  const f = fixture(t, "native-blitter", true);
  if (!f.prepared)
    return t.skip("optional scalar native build is not prepared");
  const status = f.load();
  assert.equal(status.available, true, status.reason);
  assert.equal(status.sourceSha256, f.sourceSha256);
  assert.equal(status.binarySha256, hash(f.binary));
  assert.equal(status.kernel, "scalar");
  assert.equal(status.build.forceScalar, true);
});
