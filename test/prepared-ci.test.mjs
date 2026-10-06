import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  conservativePeak,
  parsePreparedCi,
  runPreparedCi,
} from "../scripts/run-prepared-ci.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("prepared benchmark pins the default fixture and creates a distinct output scope", () => {
  const config = parsePreparedCi(["artifacts/new-benchmark"], repository);
  assert.equal(config.root, join(repository, "artifacts/new-benchmark"));
  assert.equal(
    config.worldPath,
    join(repository, "fixtures/example-world.wld"),
  );
  assert.equal(config.assetDir, join(repository, "example/assets"));
  assert.deepEqual(config.flags, [
    "--expect-world-sha256",
    "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
  ]);
  assert.equal(config.compressionLevel, "6");
  assert.deepEqual(parsePreparedCi(["--help"]), { help: true });
});

test("prepared benchmark forwards the exact custom scope and matches replay compression", () => {
  const args = [
    "output",
    "--world",
    "custom.wld",
    "--assets",
    "custom-assets",
    "--",
    "--rect",
    "10,20,30,40",
    "--compression-level",
    "3",
  ];
  const original = [...args],
    config = parsePreparedCi(args, repository);
  assert.deepEqual(args, original);
  assert.equal(config.worldPath, join(repository, "custom.wld"));
  assert.equal(config.assetDir, join(repository, "custom-assets"));
  assert.deepEqual(config.flags, [
    "--rect",
    "10,20,30,40",
    "--compression-level",
    "3",
  ]);
  assert.equal(config.compressionLevel, "3");
  for (const invalid of [
    ["--world"],
    ["--assets", "--"],
    ["--rect", "0,0,1,1"],
    ["--", "--compression-level", "10"],
    ["--", "--compression-level"],
  ])
    assert.throws(
      () => parsePreparedCi(invalid),
      /Missing value|Unknown harness|compression-level/,
    );
});

test("conservative lifetime peak sums all measured components and the reporting reserve", () => {
  const lifetime = {
    exporterOsPeakRssBytes: 200000000,
    monitorOsPeakRssBytes: 6000000,
  };
  assert.equal(conservativePeak(lifetime, 45000000), 252048576);
  for (const invalid of [
    null,
    {},
    { ...lifetime, exporterOsPeakRssBytes: -1 },
    { ...lifetime, monitorOsPeakRssBytes: Infinity },
  ])
    assert.throws(() => conservativePeak(invalid, 45000000), /Invalid/);
  assert.throws(() => conservativePeak(lifetime, NaN), /Invalid/);
  assert.throws(
    () =>
      conservativePeak(
        {
          exporterOsPeakRssBytes: Number.MAX_SAFE_INTEGER,
          monitorOsPeakRssBytes: 0,
        },
        45000000,
      ),
    /integer range/,
  );
});

test(
  "prepared benchmark refuses an existing directory before builds or export",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    await assert.rejects(
      runPreparedCi({ root: repository }),
      /fresh benchmark output directory/,
    );
  },
);
