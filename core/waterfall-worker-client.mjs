/** Isolated browser-worker channel. No world parsing or tile scans run here. */
export const WATERFALL_WORKER_PROTOCOL = 1;
export const WATERFALL_WORKER_LIMITS = Object.freeze({
  worldBytes: 64 * 1024 * 1024,
  viewportSide: 512,
  viewportTiles: 65536,
  commands: 131072,
});
export class WaterfallWorkerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WaterfallWorkerError";
    this.code = code;
    Object.assign(this, details);
  }
}
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function validRect(r) {
  return (
    r &&
    [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.width <= 512 &&
    r.height <= 512 &&
    r.width * r.height <= 65536
  );
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject, settled: false };
};
function settle(job, result, error = false) {
  if (!job || job.settled) return;
  job.settled = true;
  (error ? job.reject : job.resolve)(result);
}
function discard(job, reason) {
  settle(job, {
    status: "discarded",
    reason,
    revision: job?.revision,
    requestId: job?.requestId,
  });
}
function cloneOptions(input = {}) {
  const allowed = new Set([
    "quality",
    "maxCommands",
    "maxWaterfalls",
    "frame",
    "slowFrame",
    "rainFrame",
    "rainBackgroundFrame",
    "snowFrame",
    "lavaRainFrame",
    "lavaRainBackgroundFrame",
    "waterStyle",
    "timeForVisualEffects",
    "colorProfile",
    "discoColor",
    "showInvisibleWalls",
  ]);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Waterfall options must be a plain data object");
  const out = {};
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new TypeError(`Unsupported waterfall worker option: ${key}`);
    const value = input[key];
    if (key === "discoColor") {
      if (!Array.isArray(value))
        throw new TypeError("Invalid waterfall disco color");
      out[key] = [...value];
    } else if (!["number", "string", "boolean"].includes(typeof value))
      throw new TypeError(`Non-data waterfall worker option: ${key}`);
    else out[key] = value;
  }
  if (
    out.maxCommands !== undefined &&
    (!integer(out.maxCommands) ||
      out.maxCommands < 1 ||
      out.maxCommands > WATERFALL_WORKER_LIMITS.commands)
  )
    throw new RangeError("Waterfall worker command budget exceeds 131072");
  return out;
}
function ownedBytes(input) {
  const view =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
  if (
    !view ||
    view.byteLength < 1 ||
    view.byteLength > WATERFALL_WORKER_LIMITS.worldBytes
  )
    throw new RangeError("Invalid waterfall WLD byte input");
  // This is the only transferred buffer. Never transfer the caller's backing
  // store, including when the caller passes a sliced view into a larger file.
  return Uint8Array.from(view).buffer;
}

/** Restore source registry methods from a structured-clone snapshot. Commands
 * keep their original cross-origin order. Queries are bounded to outputRect. */
export function restoreWaterfallSnapshot(data) {
  if (
    !data ||
    data.model !== "fresh-static" ||
    !validRect(data.outputRect) ||
    !Array.isArray(data.origins) ||
    !Array.isArray(data.commands) ||
    data.commands.length > WATERFALL_WORKER_LIMITS.commands ||
    !Array.isArray(data.failures) ||
    !Array.isArray(data.requiredAssets)
  )
    throw new WaterfallWorkerError(
      "invalid-worker-snapshot",
      "Invalid waterfall worker snapshot",
    );
  const members = new Set(data.origins.map((o) => `${o.x},${o.y}`)),
    output = { ...data.outputRect };
  const commands = data.commands;
  return {
    ...data,
    hasOrigin(x, y) {
      return data.scanComplete ? members.has(`${x},${y}`) : undefined;
    },
    commandsFor(rect) {
      if (
        !validRect(rect) ||
        rect.x < output.x ||
        rect.y < output.y ||
        rect.x + rect.width > output.x + output.width ||
        rect.y + rect.height > output.y + output.height
      )
        throw new RangeError(
          "Waterfall query outside worker snapshot output rectangle",
        );
      const left = (rect.x - output.x) * 16,
        top = (rect.y - output.y) * 16,
        right = left + rect.width * 16,
        bottom = top + rect.height * 16;
      return commands
        .filter(
          (c) =>
            c.dx < right &&
            c.dy < bottom &&
            c.dx + c.dw > left &&
            c.dy + c.dh > top,
        )
        .map((c) => ({
          ...c,
          dx: c.dx - left,
          dy: c.dy - top,
          x: c.worldX - rect.x,
          y: c.worldY - rect.y,
        }));
    },
  };
}

/**
 * initialize(bytes,{revision}) owns a fresh module worker and transfers a copy.
 * requestSnapshot({revision,requestId,viewport,outputRect?,options?}) resolves a
 * ready snapshot or a discarded status. Errors reject; there is no sync fallback.
 * One physical scan runs at once, with at most the newest pending viewport.
 */
export function createWaterfallWorkerClient({
  workerURL = new URL("../viewer/waterfall-worker.mjs", import.meta.url),
  workerFactory = (url) =>
    new Worker(url, { type: "module", name: "exploretv-waterfalls" }),
  timeoutMs = 30000,
} = {}) {
  if (typeof workerFactory !== "function")
    throw new TypeError("Worker factory required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new RangeError("Invalid waterfall worker timeout");
  let worker = null,
    generation = 0,
    revision = null,
    state = "empty",
    readyJob = null,
    inflight = null,
    pending = null,
    sequence = 0,
    closed = false;
  const detach = () => {
    const previous = worker;
    worker = null;
    if (!previous) return;
    for (const [type, listener] of [
      ["message", onMessage],
      ["error", onError],
      ["messageerror", onMessageError],
    ])
      try {
        previous.removeEventListener?.(type, listener);
      } catch {}
    try {
      previous.terminate?.();
    } catch {}
  };
  let onMessage = () => {},
    onError = () => {},
    onMessageError = () => {};
  const clearTimers = () => {
    for (const job of [readyJob, inflight, pending])
      if (job?.timer) clearTimeout(job.timer);
  };
  const cancelAll = (reason) => {
    clearTimers();
    discard(readyJob, reason);
    discard(inflight, reason);
    discard(pending, reason);
    readyJob = inflight = pending = null;
  };
  function armTimeout(job, phase) {
    job.timer = setTimeout(() => {
      if (job === readyJob || job === inflight)
        failAll(
          new WaterfallWorkerError(
            "worker-timeout",
            `Waterfall worker ${phase} timed out`,
            { revision, phase, requestId: job.requestId },
          ),
        );
    }, timeoutMs);
  }
  function failAll(error) {
    clearTimers();
    settle(readyJob, error, true);
    settle(inflight, error, true);
    settle(pending, error, true);
    readyJob = inflight = pending = null;
    state = "failed";
    generation++;
    detach();
  }
  function pump() {
    if (state !== "ready" || inflight || !pending || !worker) return;
    inflight = pending;
    pending = null;
    armTimeout(inflight, "snapshot");
    try {
      worker.postMessage({
        protocol: WATERFALL_WORKER_PROTOCOL,
        type: "snapshot",
        revision,
        sequence: inflight.sequence,
        requestId: inflight.requestId,
        viewport: inflight.viewport,
        outputRect: inflight.outputRect,
        options: inflight.options,
      });
    } catch (error) {
      failAll(
        new WaterfallWorkerError("worker-post-failed", error.message, {
          revision,
          phase: "snapshot",
        }),
      );
    }
  }
  function initialize(input, { revision: nextRevision } = {}) {
    if (closed)
      throw new WaterfallWorkerError(
        "terminated",
        "Waterfall worker client is terminated",
      );
    if (!integer(nextRevision))
      throw new RangeError("Invalid waterfall world revision");
    const copy = ownedBytes(input);
    cancelAll("world-replaced");
    generation++;
    detach();
    revision = nextRevision;
    state = "initializing";
    const token = generation,
      job = { ...deferred(), revision };
    readyJob = job;
    try {
      worker = workerFactory(workerURL);
      if (
        !worker ||
        typeof worker.postMessage !== "function" ||
        typeof worker.addEventListener !== "function" ||
        typeof worker.removeEventListener !== "function" ||
        typeof worker.terminate !== "function"
      )
        throw new TypeError(
          "Worker factory must return a browser Worker-compatible instance",
        );
      onMessage = (event) => {
        if (token !== generation || closed) return;
        const message = event.data;
        if (
          !message ||
          message.protocol !== WATERFALL_WORKER_PROTOCOL ||
          message.revision !== revision
        )
          return;
        if (message.type === "ready" && state === "initializing") {
          clearTimeout(readyJob?.timer);
          state = "ready";
          settle(readyJob, {
            status: "ready",
            revision,
            world: message.world,
            parseMs: message.parseMs,
          });
          readyJob = null;
          pump();
          return;
        }
        if (
          message.type === "error" &&
          message.phase === "initialize" &&
          state === "initializing"
        ) {
          failAll(
            new WaterfallWorkerError(
              message.code ?? "worker-initialize-failed",
              message.message ?? "Waterfall initialization failed",
              { revision, phase: "initialize" },
            ),
          );
          return;
        }
        if (
          !inflight ||
          message.sequence !== inflight.sequence ||
          message.requestId !== inflight.requestId
        )
          return;
        const current = inflight;
        clearTimeout(current.timer);
        inflight = null;
        if (message.type === "snapshot") {
          if (!current.settled) {
            try {
              settle(current, {
                status: "ready",
                revision,
                requestId: current.requestId,
                ...restoreWaterfallSnapshot(message.snapshot),
              });
            } catch (error) {
              settle(current, error, true);
            }
          }
        } else if (message.type === "error") {
          settle(
            current,
            new WaterfallWorkerError(
              message.code ?? "worker-snapshot-failed",
              message.message ?? "Waterfall snapshot failed",
              { revision, requestId: current.requestId, phase: "snapshot" },
            ),
            true,
          );
        } else
          settle(
            current,
            new WaterfallWorkerError(
              "worker-protocol-error",
              "Unexpected waterfall worker response",
              { revision, requestId: current.requestId },
            ),
            true,
          );
        pump();
      };
      onError = (event) => {
        if (token !== generation || closed) return;
        event.preventDefault?.();
        failAll(
          new WaterfallWorkerError(
            "worker-crashed",
            event.message ?? "Waterfall worker failed",
            { revision },
          ),
        );
      };
      onMessageError = () => {
        if (token !== generation || closed) return;
        failAll(
          new WaterfallWorkerError(
            "worker-message-error",
            "Waterfall worker result could not be decoded",
            { revision },
          ),
        );
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      armTimeout(job, "initialize");
      worker.postMessage(
        {
          protocol: WATERFALL_WORKER_PROTOCOL,
          type: "initialize",
          revision,
          bytes: copy,
        },
        [copy],
      );
    } catch (error) {
      failAll(
        new WaterfallWorkerError("worker-initialize-failed", error.message, {
          revision,
          phase: "initialize",
        }),
      );
    }
    return job.promise;
  }
  function requestSnapshot({
    revision: requestedRevision,
    requestId,
    viewport,
    outputRect = viewport,
    options = {},
  } = {}) {
    if (closed)
      throw new WaterfallWorkerError(
        "terminated",
        "Waterfall worker client is terminated",
      );
    if (!integer(requestedRevision) || !integer(requestId))
      throw new RangeError("Invalid waterfall request/revision");
    if (!["initializing", "ready"].includes(state))
      throw new WaterfallWorkerError(
        "world-not-ready",
        "Initialize the waterfall worker before requesting a snapshot",
        { revision },
      );
    if (requestedRevision !== revision)
      return Promise.resolve({
        status: "discarded",
        reason: "stale-revision",
        revision: requestedRevision,
        requestId,
      });
    if (!validRect(viewport) || !validRect(outputRect))
      throw new RangeError(
        "Invalid bounded waterfall viewport/output rectangle",
      );
    const frozenOptions = cloneOptions(options),
      job = {
        ...deferred(),
        revision,
        requestId,
        sequence: ++sequence,
        viewport: { ...viewport },
        outputRect: { ...outputRect },
        options: frozenOptions,
      };
    discard(inflight, "superseded");
    discard(pending, "superseded");
    pending = job;
    pump();
    return job.promise;
  }
  function terminate() {
    if (closed) return;
    closed = true;
    cancelAll("terminated");
    state = "terminated";
    generation++;
    detach();
  }
  return {
    initialize,
    requestSnapshot,
    terminate,
    dispose: terminate,
    getState: () => ({
      state,
      revision,
      generation,
      inflightRequestId: inflight?.requestId ?? null,
      pendingRequestId: pending?.requestId ?? null,
    }),
  };
}
