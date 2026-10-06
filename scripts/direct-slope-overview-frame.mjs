import { createCanvas as defaultCreateCanvas } from "@napi-rs/canvas";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import {
  canonicalSlopeClip,
  prepareClippedOverviewFrame,
} from "./slope-overview-frame.mjs";

/**
 * Prepare one exact canonical slope variant for a bounded native pixel cache.
 *
 * This is a cache-miss adapter, not a new clipping or paint implementation. The
 * original frame preparer validates the source, crop, paint and vertex tint;
 * the original slope baker applies clip, opacity and UV flips in Canvas order.
 * Applying those operations to an already opacity-scaled raw plane would change
 * rounding on the antialiased diagonal. No Canvas survives this call, including
 * partially created frames when a custom factory or readback fails.
 *
 * Callers must qualify the cache by immutable source/registration identity,
 * dimensions, encoding, opaque-scene mode, the complete sceneFrameKey(command),
 * canonicalSlopeClip(command), both flip flags and quantizeCanvasOpacity(alpha).
 * Returned pixels have flips and opacity baked in; native descriptors use no
 * additional flips or alpha. A slope never supplies a full-cell opaque mean.
 *
 * Noncanonical geometry or another encoding returns null. Established original
 * preparation failures retain their reason; an unexpected preparation/readback
 * exception returns null. Both results require the ordinary diagnostic path,
 * and must never be counted as a handled or rendered command.
 */
export function prepareCanonicalSlopeOverviewFrame(
  command,
  source,
  {
    createCanvas = defaultCreateCanvas,
    inputEncoding = "tconvert-game-raw",
    opaqueScene = true,
  } = {},
) {
  if (inputEncoding === "standard-straight") return null;
  if (inputEncoding !== "tconvert-game-raw")
    throw new Error("Unknown asset channel encoding");
  if (canonicalSlopeClip(command) === null) return null;
  if (typeof createCanvas !== "function")
    throw new TypeError("Canonical slope requires a Canvas factory");

  const canvases = [];
  const temporaryCanvas = (width, height) => {
    const canvas = createCanvas(width, height);
    canvases.push(canvas);
    return canvas;
  };
  let frames = null;
  try {
    frames = prepareSceneFrames(
      { commands: [command] },
      new Map(source ? [[command.asset, source]] : []),
      temporaryCanvas,
      {
        inputEncoding,
        opaqueScene,
        maxFrames: 1,
        maxBytes: 16 * 16 * 8,
      },
    );
    const frame = frames.resolve(command);
    if (frame?.unsupported) return { unsupported: frame.unsupported };
    if (!frame?.base) return null;
    const pixels = prepareClippedOverviewFrame(frame, command, temporaryCanvas);
    return pixels ? { ...pixels, mean: null } : null;
  } catch {
    // Preserve generic diagnostics when the adapter cannot prove a valid draw.
    return null;
  } finally {
    try {
      frames?.dispose();
    } finally {
      // The original disposers release complete frames and the clip surface.
      // A factory/getContext failure can leave a surface before either owner
      // acquires it, so also retire that small partial construction here.
      for (const canvas of canvases) {
        if (canvas.width !== 1) canvas.width = 1;
        if (canvas.height !== 1) canvas.height = 1;
      }
    }
  }
}
