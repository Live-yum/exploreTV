import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { decodePngRgba } from "../core/png-rgba.mjs";

const MAX_VALIDATED_STREAMS = 512;

/**
 * Accelerate repeated PNG inflation without widening the reference decoder's
 * accepted inputs. A new exact IDAT stream and output length always pass the
 * original bounded DEFLATE validator first, including its block-count limit.
 * Native/reference acceptance can differ for uncommon valid streams. A native
 * failure retries the strict reference and keeps that hash reference-only.
 * Only SHA-256 acceptance metadata is retained, never compressed/raw pixels.
 * All PNG chunk, CRC, size, ordering and filter checks run on every decode.
 */
export function createNodePngRgbaDecoder({
  maxStreams = MAX_VALIDATED_STREAMS,
} = {}) {
  if (
    !Number.isSafeInteger(maxStreams) ||
    maxStreams < 1 ||
    maxStreams > MAX_VALIDATED_STREAMS
  )
    throw new Error("Invalid validated PNG stream cache budget");
  const validated = new Map();
  const stats = {
    strictInflations: 0,
    nativeInflations: 0,
    nativeFallbacks: 0,
    cachedStreams: 0,
    evictions: 0,
  };
  const inflate = (bytes, expectedLength, strictInflate) => {
    const key =
      expectedLength + ":" + createHash("sha256").update(bytes).digest("hex");
    if (!validated.has(key)) {
      const output = strictInflate(bytes, expectedLength);
      if (validated.size >= maxStreams) {
        validated.delete(validated.keys().next().value);
        stats.evictions++;
      }
      validated.set(key, true);
      stats.strictInflations++;
      stats.cachedStreams = validated.size;
      return output;
    }
    if (!validated.get(key)) {
      const output = strictInflate(bytes, expectedLength);
      validated.delete(key);
      validated.set(key, false);
      stats.strictInflations++;
      return output;
    }
    let output;
    try {
      const { buffer, engine } = inflateSync(bytes, {
        info: true,
        maxOutputLength: expectedLength,
        // IHDR validation already bounds the exact filtered length. One output
        // slab avoids the default chunk list; one spare byte also prevents an
        // exact-fill EOF check from allocating a second full-size slab.
        chunkSize: Math.max(64, expectedLength + 1),
      });
      if (buffer.length !== expectedLength)
        throw new Error("PNG: inflated output does not match dimensions");
      if (engine.bytesWritten !== bytes.length)
        throw new Error("PNG: trailing bytes in zlib stream");
      output = buffer;
    } catch {
      // Byte-identical reference-valid inputs must remain usable even if the
      // platform zlib accepts a narrower DEFLATE set. Retry once, then remember
      // only the bounded reference-only mode, not the decoded pixels.
      output = strictInflate(bytes, expectedLength);
      validated.delete(key);
      validated.set(key, false);
      stats.strictInflations++;
      stats.nativeFallbacks++;
      return output;
    }
    validated.delete(key);
    validated.set(key, true);
    stats.nativeInflations++;
    return output;
  };
  return {
    decode(input) {
      return decodePngRgba(input, { inflate, reuseInflatedBuffer: true });
    },
    clear() {
      validated.clear();
      stats.cachedStreams = 0;
    },
    stats,
  };
}
