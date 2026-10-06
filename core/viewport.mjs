/** Platform-neutral, bounded full-detail camera and resource ownership helpers. */
export const VIEWPORT_LIMITS = Object.freeze({
  tilePixels: 16,
  minZoom: 0.5,
  maxZoom: 4,
  maxWidth: 1920,
  maxHeight: 1024,
  halo: 12,
  regionTiles: 65536,
  cacheBytes: 48 * 1024 * 1024,
});
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const finite = (n, name) => {
  if (!Number.isFinite(n)) throw new RangeError(`Invalid ${name}`);
  return n;
};
export function viewportSize(width, height) {
  return {
    width: clamp(
      Math.floor(finite(width, "viewport width")),
      1,
      VIEWPORT_LIMITS.maxWidth,
    ),
    height: clamp(
      Math.floor(finite(height, "viewport height")),
      1,
      VIEWPORT_LIMITS.maxHeight,
    ),
  };
}
export function clampCamera(camera, world, size) {
  const zoom = clamp(
    finite(camera.zoom, "zoom"),
    VIEWPORT_LIMITS.minZoom,
    VIEWPORT_LIMITS.maxZoom,
  );
  return {
    x: clamp(
      finite(camera.x, "camera x"),
      0,
      Math.max(0, world.width * 16 - size.width / zoom),
    ),
    y: clamp(
      finite(camera.y, "camera y"),
      0,
      Math.max(0, world.height * 16 - size.height / zoom),
    ),
    zoom,
  };
}
export function screenToWorld(camera, x, y) {
  return { x: camera.x + x / camera.zoom, y: camera.y + y / camera.zoom };
}
export function panCamera(camera, dx, dy, world, size) {
  return clampCamera(
    {
      ...camera,
      x: camera.x - dx / camera.zoom,
      y: camera.y - dy / camera.zoom,
    },
    world,
    size,
  );
}
export function zoomCamera(camera, zoom, anchor, world, size) {
  zoom = clamp(
    finite(zoom, "zoom"),
    VIEWPORT_LIMITS.minZoom,
    VIEWPORT_LIMITS.maxZoom,
  );
  const point = screenToWorld(camera, anchor.x, anchor.y);
  return clampCamera(
    { x: point.x - anchor.x / zoom, y: point.y - anchor.y / zoom, zoom },
    world,
    size,
  );
}
export function jumpCamera(camera, tileX, tileY, world, size) {
  if (
    ![tileX, tileY].every(Number.isInteger) ||
    tileX < 0 ||
    tileY < 0 ||
    tileX >= world.width ||
    tileY >= world.height
  )
    throw new RangeError(
      `Coordinates must be within 0..${world.width - 1}, 0..${world.height - 1}`,
    );
  return clampCamera(
    {
      x: (tileX + 0.5) * 16 - size.width / camera.zoom / 2,
      y: (tileY + 0.5) * 16 - size.height / camera.zoom / 2,
      zoom: camera.zoom,
    },
    world,
    size,
  );
}
export function viewportRegion(camera, world, requestedSize) {
  const size = viewportSize(requestedSize.width, requestedSize.height);
  camera = clampCamera(camera, world, size);
  const x = Math.floor(camera.x / 16),
    y = Math.floor(camera.y / 16);
  const right = Math.min(
    world.width,
    Math.ceil((camera.x + size.width / camera.zoom) / 16),
  );
  const bottom = Math.min(
    world.height,
    Math.ceil((camera.y + size.height / camera.zoom) / 16),
  );
  const rect = { x, y, width: right - x, height: bottom - y };
  const hx = Math.max(0, x - VIEWPORT_LIMITS.halo),
    hy = Math.max(0, y - VIEWPORT_LIMITS.halo);
  const context = {
    x: hx,
    y: hy,
    width: Math.min(world.width, right + VIEWPORT_LIMITS.halo) - hx,
    height: Math.min(world.height, bottom + VIEWPORT_LIMITS.halo) - hy,
  };
  if (
    context.width > 512 ||
    context.height > 512 ||
    context.width * context.height > VIEWPORT_LIMITS.regionTiles
  )
    throw new RangeError("Viewport region budget exceeded");
  return { camera, size, rect, context };
}
export const insideRect = (x, y, rect) =>
  x >= rect.x &&
  y >= rect.y &&
  x < rect.x + rect.width &&
  y < rect.y + rect.height;
/** Include wall/torch overhang from the halo when it intersects actual screen pixels. */
export function visibleCommands(plan, context, camera, size) {
  const left = camera.x - context.x * 16,
    top = camera.y - context.y * 16;
  const right = left + size.width / camera.zoom,
    bottom = top + size.height / camera.zoom;
  return plan.commands.filter(
    (c) =>
      c.dx < right && c.dy < bottom && c.dx + c.dw > left && c.dy + c.dh > top,
  );
}
/** Byte accounting includes encoded PNG, raw RGBA and decoded platform pixels. */
export class ByteLruCache {
  constructor(
    maxBytes = VIEWPORT_LIMITS.cacheBytes,
    dispose = (value) => value?.close?.(),
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("Invalid cache budget");
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.peakBytes = 0;
    this.entries = new Map();
    this.dispose = dispose;
  }
  get(key) {
    const item = this.entries.get(key);
    if (!item) return undefined;
    this.entries.delete(key);
    this.entries.set(key, item);
    return item.value;
  }
  reserve(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes)
      throw new RangeError("Texture exceeds cache budget");
    while (this.bytes + bytes > this.maxBytes)
      this.delete(this.entries.keys().next().value);
  }
  set(key, value, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes)
      throw new RangeError("Texture exceeds cache budget");
    this.delete(key);
    this.reserve(bytes);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this.peakBytes = Math.max(this.bytes, this.peakBytes);
    return value;
  }
  delete(key) {
    const item = this.entries.get(key);
    if (!item) return;
    this.entries.delete(key);
    this.bytes -= item.bytes;
    this.dispose(item.value);
  }
  clear() {
    for (const key of this.entries.keys()) this.delete(key);
  }
}
/** Serial work + generation checks: old asynchronous fetches never commit over a new camera. */
export class LatestRenderQueue {
  constructor(run, commit, onError = () => {}) {
    this.run = run;
    this.commit = commit;
    this.onError = onError;
    this.revision = 0;
    this.running = false;
    this.pending = null;
    this.waiters = [];
  }
  invalidate() {
    this.revision++;
    this.pending = null;
  }
  request(value) {
    const revision = ++this.revision;
    this.pending = { revision, value };
    if (!this.running) void this.drain();
    return revision;
  }
  async drain() {
    this.running = true;
    while (this.pending) {
      const { revision, value } = this.pending;
      this.pending = null;
      const current = () => revision === this.revision;
      try {
        const result = await this.run(value, current);
        if (current()) await this.commit(result, value, revision);
      } catch (error) {
        if (current()) this.onError(error);
      }
    }
    this.running = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  idle() {
    return this.running
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
}
