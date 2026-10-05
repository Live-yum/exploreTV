import { openWorld, getWorldTileAccessor, LIMITS } from "../core/world.mjs";
import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";

const PROTOCOL = 1;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function rect(r, world) {
  return (
    r &&
    [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.width <= 512 &&
    r.height <= 512 &&
    r.width * r.height <= 65536 &&
    r.x + r.width <= world.width &&
    r.y + r.height <= world.height
  );
}
const elapsed = (start) =>
  (globalThis.performance?.now?.() ?? Date.now()) - start;
const now = () => globalThis.performance?.now?.() ?? Date.now();

/** Exported for worker-thread tests. Browser code imports only the client. */
export function createWaterfallWorkerHandler(send) {
  if (typeof send !== "function")
    throw new TypeError("Worker reply function required");
  let world = null,
    getTile = null,
    revision = null;
  return (message) => {
    if (!message || message.protocol !== PROTOCOL) return;
    const phase = message.type === "initialize" ? "initialize" : "snapshot";
    const identity = {
      protocol: PROTOCOL,
      revision: message.revision,
      requestId: message.requestId,
      sequence: message.sequence,
    };
    try {
      if (!integer(message.revision))
        throw new RangeError("Invalid world revision");
      if (message.type === "initialize") {
        world = getTile = null;
        revision = message.revision;
        if (
          !(message.bytes instanceof ArrayBuffer) ||
          message.bytes.byteLength < 1 ||
          message.bytes.byteLength > LIMITS.fileBytes
        )
          throw new RangeError("Invalid WLD byte copy");
        const start = now(),
          opened = openWorld(new Uint8Array(message.bytes));
        if (!Number.isFinite(opened.worldSurface))
          throw new Error("World surface unavailable for waterfall rendering");
        world = opened;
        getTile = getWorldTileAccessor(world);
        send({
          ...identity,
          type: "ready",
          world: {
            width: world.width,
            height: world.height,
            version: world.version,
            worldSurface: world.worldSurface,
          },
          parseMs: elapsed(start),
        });
        return;
      }
      if (message.type !== "snapshot")
        throw new Error("Unknown waterfall worker request");
      if (!world || !getTile) throw new Error("World is not initialized");
      if (message.revision !== revision) {
        send({ ...identity, type: "discarded", reason: "stale-revision" });
        return;
      }
      if (!integer(message.requestId) || !integer(message.sequence))
        throw new RangeError("Invalid snapshot identity");
      if (!rect(message.viewport, world) || !rect(message.outputRect, world))
        throw new RangeError("Invalid bounded viewport/output rectangle");
      const options = message.options ?? {};
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new TypeError("Invalid snapshot options");
      const maxCommands = options.maxCommands ?? 131072;
      if (!integer(maxCommands) || maxCommands < 1 || maxCommands > 131072)
        throw new RangeError("Worker command budget exceeds 131072");
      const start = now(),
        registry = createStaticWaterfallRegistry(
          {
            width: world.width,
            height: world.height,
            worldSurface: world.worldSurface,
            getTile,
          },
          { ...options, maxCommands, viewport: { ...message.viewport } },
        );
      const { hasOrigin, commandsFor, ...metadata } = registry;
      // The registry scans only the requested viewport's source halo. This query
      // selects sprites in the requested output ROI; it never scans world tiles.
      const commands = registry.commandsFor(message.outputRect);
      send({
        ...identity,
        type: "snapshot",
        snapshot: {
          ...metadata,
          outputRect: { ...message.outputRect },
          commands,
          computeMs: elapsed(start),
        },
      });
    } catch (error) {
      send({
        ...identity,
        type: "error",
        phase,
        code:
          phase === "initialize"
            ? "worker-initialize-failed"
            : "worker-snapshot-failed",
        name: error.name,
        message: error.message,
      });
    }
  };
}

if (
  typeof DedicatedWorkerGlobalScope !== "undefined" &&
  globalThis instanceof DedicatedWorkerGlobalScope
) {
  const handle = createWaterfallWorkerHandler((message) =>
    globalThis.postMessage(message),
  );
  globalThis.addEventListener("message", (event) => handle(event.data));
}
