const MAX_BYTES = 6 * 1024 * 1024;

/**
 * One bounded detailed RGBA allocation, borrowed by synchronous render stages.
 * A released view is invalid: the next lease may overwrite the same bytes.
 * Capacity is allocated once, rather than grown while old views can retain it.
 */
export function createOverviewRgbaArena({ maxBytes = MAX_BYTES } = {}) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 4 ||
    maxBytes > MAX_BYTES ||
    maxBytes % 4 !== 0
  )
    throw new RangeError("Invalid overview RGBA arena capacity");
  let backing = null,
    active = null,
    disposed = false;
  const stats = {
    maxBytes,
    bufferBytes: 0,
    peakBufferBytes: 0,
    activeBytes: 0,
    peakActiveBytes: 0,
    allocations: 0,
    acquisitions: 0,
    releases: 0,
    rejectedAcquisitions: 0,
  };
  return Object.freeze({
    maxBytes,
    stats,
    acquire(bytes) {
      if (disposed) throw new Error("Overview RGBA arena is disposed");
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 4 ||
        bytes > maxBytes ||
        bytes % 4 !== 0
      )
        throw new RangeError("Overview RGBA request exceeds arena capacity");
      if (active !== null) {
        stats.rejectedAcquisitions++;
        throw new Error("Overview RGBA arena already has an active lease");
      }
      if (!backing) {
        // An unpooled allocation also obeys the exact cap for small test cores.
        backing = Buffer.allocUnsafeSlow(maxBytes);
        stats.bufferBytes = stats.peakBufferBytes = backing.byteLength;
        stats.allocations++;
      }
      const token = {};
      active = token;
      stats.activeBytes = bytes;
      stats.peakActiveBytes = Math.max(stats.peakActiveBytes, bytes);
      stats.acquisitions++;
      return Object.freeze({
        pixels: backing.subarray(0, bytes),
        release() {
          // A stale lease cannot release a later borrower of the same buffer.
          if (active !== token) return;
          active = null;
          stats.activeBytes = 0;
          stats.releases++;
        },
      });
    },
    dispose() {
      if (disposed) return;
      if (active !== null)
        throw new Error(
          "Cannot dispose overview RGBA arena with an active lease",
        );
      disposed = true;
      backing = null;
      stats.bufferBytes = 0;
    },
  });
}
