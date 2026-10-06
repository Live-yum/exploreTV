import {
  FRAME_LIMITS,
  prepareSceneFrames,
  sceneFrameKey,
} from "./scene-frames.mjs";
import { renderScene } from "./renderer.mjs";

/** Conservative reservation includes both source-over and additive surfaces. */
export function sceneFrameReservedBytes(command) {
  const width = command.vertexColors ? command.dw : command.sw;
  const height = command.vertexColors ? command.dh : command.sh;
  if (
    ![width, height].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= FRAME_LIMITS.maxSide,
    )
  )
    return FRAME_LIMITS.maxSide ** 2 * 8;
  return width * height * 8;
}

/** Contiguous batches preserve all sprite ordering, including additive layers. */
export function* sceneCommandBatches(
  commands,
  {
    maxFrames = 256,
    maxBytes = FRAME_LIMITS.maxBytes,
    maxCommands = 2048,
    oneAsset = false,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > FRAME_LIMITS.maxFrames ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < FRAME_LIMITS.maxSide ** 2 * 8 ||
    maxBytes > FRAME_LIMITS.maxBytes ||
    !Number.isSafeInteger(maxCommands) ||
    maxCommands < 1 ||
    maxCommands > 131072
  )
    throw new Error("Invalid scene batch budget");
  let batch = [],
    keys = new Set(),
    bytes = 0,
    asset;
  for (const command of commands) {
    const key = sceneFrameKey(command),
      extra = keys.has(key) ? 0 : sceneFrameReservedBytes(command);
    if (
      batch.length &&
      ((oneAsset && asset !== command.asset) ||
        batch.length >= maxCommands ||
        (!keys.has(key) && keys.size >= maxFrames) ||
        bytes + extra > maxBytes)
    ) {
      yield batch;
      batch = [];
      keys = new Set();
      bytes = 0;
    }
    asset = command.asset;
    if (!keys.has(key)) {
      keys.add(key);
      bytes += sceneFrameReservedBytes(command);
    }
    batch.push(command);
  }
  if (batch.length) yield batch;
}

/** Own only one bounded frame cache at a time; initialize the scene exactly once. */
export function renderSceneBatched(
  context,
  plan,
  assets,
  createCanvas,
  options = {},
) {
  const warnings = new Set(plan.warnings),
    missing = new Set(),
    invalid = new Set();
  const support = {
    preparedFrames: 0,
    bytes: 0,
    peakBytes: 0,
    batches: 0,
    unsupportedCommands: 0,
  };
  let drawn = 0,
    skippedEffects = 0;
  if (options.opaqueScene) {
    context.save();
    try {
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "#000000";
      context.fillRect(0, 0, plan.width, plan.height);
    } finally {
      context.restore();
    }
  }
  for (const commands of sceneCommandBatches(plan.commands, options.batch)) {
    const part = { ...plan, commands, warnings: [] };
    const frames = prepareSceneFrames(part, assets, createCanvas, options);
    try {
      const result = renderScene(context, part, assets, {
        strict: options.strict,
        sceneFrames: { ...frames, opaqueScene: false },
      });
      drawn += result.drawn;
      skippedEffects += result.skippedEffects;
      result.warnings.forEach((v) => warnings.add(v));
      result.missingAssets.forEach((v) => missing.add(v));
      result.invalidAssets.forEach((v) => invalid.add(v));
      support.batches++;
      support.preparedFrames += frames.support.preparedFrames;
      support.bytes += frames.support.bytes;
      support.peakBytes = Math.max(support.peakBytes, frames.support.bytes);
      support.unsupportedCommands += frames.support.unsupportedCommands;
    } finally {
      frames.dispose();
    }
  }
  return {
    drawn,
    skippedEffects,
    paintSupport: support,
    missingAssets: [...missing].sort(),
    invalidAssets: [...invalid].sort(),
    warnings: [...warnings],
  };
}
