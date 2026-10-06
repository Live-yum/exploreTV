import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OVERVIEW_FRAME_PACK_RULE_PATHS } from "./overview-frame-pack-format.mjs";

const SHA = /^[0-9a-f]{64}$/;

/** Bind the executed resource pack to the measured source and texture bytes. */
export function verifyOverviewFramePack(render, { assetDir } = {}) {
  const pack = render.framePack;
  if (!pack?.available) return null;
  assert.match(pack.manifestSha256, SHA, "Frame pack manifest identity");
  assert.match(pack.indexSha256, SHA, "Frame pack index identity");
  assert.ok(Number.isSafeInteger(pack.frames) && pack.frames > 0);
  assert.ok(
    Number.isSafeInteger(pack.uniqueFrames) &&
      pack.uniqueFrames > 0 &&
      pack.uniqueFrames <= pack.frames,
  );
  for (const key of [
    "logicalPixelBytes",
    "pixelBytes",
    "onDiskBytes",
    "indexBytes",
  ])
    assert.ok(
      Number.isSafeInteger(pack[key]) && pack[key] > 0,
      `Frame pack ${key}`,
    );
  assert.equal(pack.indexBytes, pack.frames * 32);
  assert.ok(pack.pixelBytes <= pack.logicalPixelBytes);
  assert.ok(pack.onDiskBytes > pack.pixelBytes + pack.indexBytes);
  assert.ok(Number.isSafeInteger(pack.pageCount) && pack.pageCount > 0);
  assert.ok(Array.isArray(pack.pagesSha256));
  assert.equal(pack.pagesSha256.length, pack.pageCount);
  for (const hash of pack.pagesSha256) assert.match(hash, SHA);
  assert.equal(pack.validationFailures, 0, "No failed pack validation");
  assert.ok(pack.sourceVerifications > 0, "Source bytes must be verified");
  assert.deepEqual(
    Object.keys(pack.ruleHashes ?? {}).sort(),
    [...OVERVIEW_FRAME_PACK_RULE_PATHS].sort(),
    "All frame preparation rules are bound",
  );
  for (const [name, hash] of Object.entries(pack.ruleHashes)) {
    assert.match(hash, SHA);
    assert.equal(
      render.sourceHashes[name],
      hash,
      `Frame preparation rule: ${name}`,
    );
  }
  assert.ok(Object.keys(pack.sourceHashes ?? {}).length > 0);
  for (const [name, hash] of Object.entries(pack.sourceHashes)) {
    assert.match(name, /^[A-Za-z0-9_-]+\.png$/);
    assert.match(hash, SHA);
    if (Object.hasOwn(render.assetHashes, name))
      assert.equal(
        render.assetHashes[name],
        hash,
        `Executed packed texture: ${name}`,
      );
    if (assetDir)
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(assetDir, name)))
          .digest("hex"),
        hash,
        `Packed source texture: ${name}`,
      );
  }
  const direct = render.directTerrainOverviewStats;
  assert.ok(direct?.packFrameHits > 0, "Prepared pixels must be consumed");
  assert.equal(direct.packFailures, 0, "No unexpected packed-frame fallback");
  assert.equal(
    direct.frameByteLimit,
    4 * 1024 * 1024,
    "Unchanged live frame budget",
  );
  for (const key of ["peakLiveFrameBytes", "peakPackPageBytes"])
    assert.ok(
      Number.isSafeInteger(direct[key]) && direct[key] >= 0,
      `Valid live byte count: ${key}`,
    );
  assert.ok(
    direct.peakLiveFrameBytes <= direct.frameByteLimit,
    "Pages and fallback frames share the live frame budget",
  );
  assert.ok(
    direct.peakPackPageBytes <= direct.frameByteLimit,
    "Whole resident pages remain bounded",
  );
  if (direct.framePackCopyPixels) {
    assert.ok(
      direct.packCopiedFrames > 0,
      "Prepared frame copies must execute",
    );
    assert.equal(
      direct.packBudgetFallbacks,
      0,
      "No unexpected copy budget fallback",
    );
    assert.ok(
      Number.isSafeInteger(direct.peakPackStagingBytes) &&
        direct.peakPackStagingBytes > 0 &&
        direct.peakPackStagingBytes <= 256 * 1024,
      "One bounded staging page",
    );
    assert.equal(
      direct.peakPackPageBytes,
      direct.peakPackStagingBytes,
      "No second pixel page cache",
    );
    assert.ok(
      Number.isSafeInteger(direct.packResidentPages) &&
        direct.packResidentPages >= 0 &&
        direct.packResidentPages <= 1,
    );
  }
  return {
    manifestSha256: pack.manifestSha256,
    indexSha256: pack.indexSha256,
    pagesSha256: [...pack.pagesSha256],
    ruleHashes: { ...pack.ruleHashes },
    sourceHashes: { ...pack.sourceHashes },
    frames: pack.frames,
    uniqueFrames: pack.uniqueFrames,
    pageCount: pack.pageCount,
    logicalPixelBytes: pack.logicalPixelBytes,
    pixelBytes: pack.pixelBytes,
    onDiskBytes: pack.onDiskBytes,
    indexBytes: pack.indexBytes,
  };
}
