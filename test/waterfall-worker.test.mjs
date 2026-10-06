import test from "node:test";
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createWaterfallWorkerClient,
  restoreWaterfallSnapshot,
  WATERFALL_WORKER_PROTOCOL,
} from "../core/waterfall-worker-client.mjs";
import { fixtureWorld, record } from "./fixture.mjs";
import { openWorld, getWorldTileAccessor } from "../core/world.mjs";
import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";

const viewport = { x: 100, y: 70, width: 40, height: 40 };
class FakeWorker {
  constructor() {
    this.messages = [];
    this.handlers = new Map();
    this.history = new Map();
    this.terminated = 0;
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    if (!this.history.has(type)) this.history.set(type, new Set());
    this.history.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }
  postMessage(data, transfer = []) {
    this.messages.push(structuredClone(data, { transfer }));
  }
  terminate() {
    this.terminated++;
  }
  emit(type, data, stale = false) {
    for (const fn of (stale ? this.history : this.handlers).get(type) ?? [])
      fn(
        type === "message"
          ? { data }
          : { message: String(data), preventDefault() {} },
      );
  }
  ready(revision) {
    this.emit("message", {
      protocol: 1,
      type: "ready",
      revision,
      world: { width: 260, height: 260, worldSurface: 0, version: 269 },
      parseMs: 1,
    });
  }
  reply(request, snapshot = sampleSnapshot(), extra = {}) {
    this.emit("message", {
      protocol: 1,
      type: "snapshot",
      revision: request.revision,
      requestId: request.requestId,
      sequence: request.sequence,
      snapshot,
      ...extra,
    });
  }
}
function setup() {
  const workers = [];
  const client = createWaterfallWorkerClient({
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { client, workers };
}
const sampleSnapshot = () => ({
  model: "fresh-static",
  scanComplete: true,
  outputRect: { ...viewport },
  viewport: { ...viewport },
  origins: [{ x: 120, y: 80, type: 25 }],
  commands: [
    {
      asset: "Waterfall_25.png",
      worldX: 120,
      worldY: 80,
      dx: 320,
      dy: 160,
      dw: 16,
      dh: 16,
      originIndex: 0,
    },
    {
      asset: "Waterfall_25.png",
      worldX: 120,
      worldY: 80,
      dx: 320,
      dy: 160,
      dw: 16,
      dh: 16,
      originIndex: 0,
      shimmerLayer: "sparkle",
    },
  ],
  failures: [],
  requiredAssets: ["Waterfall_25.png"],
});
async function ready(s, revision = 1) {
  const promise = s.client.initialize(Uint8Array.of(1, 2, 3), { revision });
  s.workers.at(-1).ready(revision);
  await promise;
  return s.workers.at(-1);
}
const request = (id, extra = {}) => ({
  revision: 1,
  requestId: id,
  viewport,
  ...extra,
});

test("initialization transfers an owned byte copy, retaining caller buffers and sliced views", async () => {
  const s = setup(),
    source = Uint8Array.of(99, 1, 2, 3, 88),
    view = source.subarray(1, 4),
    promise = s.client.initialize(view, { revision: 1 });
  const sent = s.workers[0].messages[0];
  assert.equal(sent.type, "initialize");
  assert.deepEqual([...new Uint8Array(sent.bytes)], [1, 2, 3]);
  assert.equal(source.byteLength, 5);
  assert.deepEqual([...source], [99, 1, 2, 3, 88]);
  assert.equal(view.byteLength, 3);
  s.workers[0].ready(1);
  assert.equal((await promise).status, "ready");
  s.client.terminate();
});

test("only the latest pending viewport survives initialization and options are captured by value", async () => {
  const s = setup(),
    initial = s.client.initialize(Uint8Array.of(1), { revision: 1 });
  const first = s.client.requestSnapshot(request(1)),
    mutable = { ...viewport },
    disco = [1, 2, 3];
  const second = s.client.requestSnapshot(
    request(2, { viewport: mutable, options: { discoColor: disco } }),
  );
  mutable.x = 500;
  disco[0] = 200;
  assert.equal((await first).reason, "superseded");
  assert.equal(s.workers[0].messages.length, 1);
  s.workers[0].ready(1);
  await initial;
  const message = s.workers[0].messages[1];
  assert.equal(message.requestId, 2);
  assert.equal(message.viewport.x, 100);
  assert.deepEqual(message.options.discoColor, [1, 2, 3]);
  s.workers[0].reply(message);
  assert.equal((await second).status, "ready");
  s.client.terminate();
});

test("single physical scan plus one latest pending request discards superseded work without reordering results", async () => {
  const s = setup(),
    worker = await ready(s),
    first = s.client.requestSnapshot(request(1));
  const firstMessage = worker.messages[1],
    second = s.client.requestSnapshot(request(2)),
    third = s.client.requestSnapshot(request(3));
  assert.equal((await first).reason, "superseded");
  assert.equal((await second).reason, "superseded");
  assert.equal(worker.messages.length, 2);
  assert.deepEqual(s.client.getState().inflightRequestId, 1);
  assert.equal(s.client.getState().pendingRequestId, 3);
  worker.reply(firstMessage);
  assert.equal(worker.messages.length, 3);
  assert.equal(worker.messages[2].requestId, 3);
  worker.reply(worker.messages[2]);
  const result = await third;
  assert.equal(result.requestId, 3);
  assert.equal(result.hasOrigin(120, 80), true);
  assert.equal(result.hasOrigin(121, 80), false);
  assert.deepEqual(
    result.commands.map((c) => c.shimmerLayer ?? "base"),
    ["base", "sparkle"],
  );
  s.client.terminate();
});

test("world revision, request sequence and stale-generation replies cannot replace current work", async () => {
  const s = setup(),
    old = await ready(s),
    first = s.client.requestSnapshot(request(1));
  const oldRequest = old.messages[1],
    initial = s.client.initialize(Uint8Array.of(4), { revision: 2 });
  assert.equal((await first).reason, "world-replaced");
  assert.equal(old.terminated, 1);
  old.emit(
    "message",
    { protocol: 1, type: "ready", revision: 2, world: { width: 1 } },
    true,
  );
  assert.equal(s.client.getState().state, "initializing");
  const current = s.workers[1];
  current.ready(2);
  await initial;
  assert.equal(
    (await s.client.requestSnapshot(request(2))).reason,
    "stale-revision",
  );
  const latest = s.client.requestSnapshot(request(3, { revision: 2 })),
    message = current.messages[1];
  old.emit(
    "message",
    {
      protocol: 1,
      type: "snapshot",
      revision: 2,
      requestId: 3,
      sequence: message.sequence,
      snapshot: sampleSnapshot(),
    },
    true,
  );
  current.reply(message, sampleSnapshot(), { revision: 1 });
  assert.equal(s.client.getState().inflightRequestId, 3);
  current.reply(message, sampleSnapshot(), { sequence: oldRequest.sequence });
  assert.equal(s.client.getState().inflightRequestId, 3);
  current.reply(message);
  assert.equal((await latest).revision, 2);
  s.client.terminate();
});

test("same-revision reinitialization still replaces and terminates the worker generation", async () => {
  const s = setup(),
    old = await ready(s),
    oldPromise = s.client.requestSnapshot(request(1));
  const initial = s.client.initialize(Uint8Array.of(3), { revision: 1 });
  assert.equal((await oldPromise).reason, "world-replaced");
  assert.equal(old.terminated, 1);
  old.emit(
    "message",
    { protocol: 1, type: "ready", revision: 1, world: {} },
    true,
  );
  assert.equal(s.client.getState().state, "initializing");
  s.workers[1].ready(1);
  assert.equal((await initial).status, "ready");
  s.client.terminate();
});

test("recoverable snapshot errors reject precisely and permit a subsequent request", async () => {
  const s = setup(),
    worker = await ready(s),
    job = s.client.requestSnapshot(request(1)),
    message = worker.messages[1];
  const rejection = assert.rejects(
    job,
    (error) => error.code === "worker-snapshot-failed" && error.requestId === 1,
  );
  worker.emit("message", {
    ...message,
    type: "error",
    phase: "snapshot",
    code: "worker-snapshot-failed",
    message: "Invalid viewport",
  });
  await rejection;
  assert.equal(s.client.getState().state, "ready");
  const next = s.client.requestSnapshot(request(2));
  worker.reply(worker.messages[2]);
  assert.equal((await next).status, "ready");
  s.client.terminate();
});

test("initialization errors, worker crashes and message decoding errors require a fresh initialization", async () => {
  for (const failure of ["initialize", "error", "messageerror"]) {
    const s = setup();
    let job;
    if (failure === "initialize")
      job = s.client.initialize(Uint8Array.of(1), { revision: 1 });
    else {
      await ready(s);
      job = s.client.requestSnapshot(request(1));
    }
    const rejected = assert.rejects(job, /bad|failed|decoded/),
      worker = s.workers[0];
    if (failure === "initialize")
      worker.emit("message", {
        protocol: 1,
        type: "error",
        revision: 1,
        phase: "initialize",
        message: "bad file",
      });
    else worker.emit(failure, "worker failed");
    await rejected;
    assert.equal(s.client.getState().state, "failed");
    assert.equal(worker.terminated, 1);
    const init = s.client.initialize(Uint8Array.of(2), { revision: 2 });
    s.workers[1].ready(2);
    assert.equal((await init).status, "ready");
    s.client.terminate();
  }
});

test("terminate is idempotent, releases queued promises and forbids subsequent work", async () => {
  const s = setup(),
    worker = await ready(s),
    first = s.client.requestSnapshot(request(1)),
    second = s.client.requestSnapshot(request(2));
  assert.equal((await first).reason, "superseded");
  s.client.terminate();
  s.client.terminate();
  assert.equal(worker.terminated, 1);
  assert.equal((await second).reason, "terminated");
  assert.throws(
    () => s.client.initialize(Uint8Array.of(1), { revision: 3 }),
    /terminated/,
  );
  assert.throws(() => s.client.requestSnapshot(request(3)), /terminated/);
});

test("request validation is bounded and never starts a synchronous fallback scan", async () => {
  const source = readFileSync(
    new URL("../core/waterfall-worker-client.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+['"][^'"]*(?:world|static-waterfalls)\.mjs/,
  );
  const s = setup(),
    worker = await ready(s);
  for (const viewport of [
    { x: 0, y: 0, width: 513, height: 1 },
    { x: 0, y: 0, width: 512, height: 512 },
  ])
    assert.throws(
      () => s.client.requestSnapshot(request(1, { viewport })),
      /bounded/,
    );
  assert.throws(
    () =>
      s.client.requestSnapshot(request(1, { options: { getTile: () => {} } })),
    /Unsupported/,
  );
  assert.throws(
    () =>
      s.client.requestSnapshot(
        request(1, { options: { maxCommands: 131073 } }),
      ),
    /budget/,
  );
  assert.equal(worker.messages.length, 1);
  s.client.terminate();
  const noWorker = createWaterfallWorkerClient({ workerFactory: () => ({}) });
  await assert.rejects(
    noWorker.initialize(Uint8Array.of(1), { revision: 1 }),
    /compatible/,
  );
  assert.equal(noWorker.getState().state, "failed");
  noWorker.terminate();
});

test("restored snapshots preserve partial-scan uncertainty, sprite overhangs and cross-origin command order", () => {
  const snapshot = sampleSnapshot();
  snapshot.commands.unshift({
    asset: "first",
    worldX: 119,
    worldY: 80,
    dx: 312,
    dy: 160,
    dw: 32,
    dh: 16,
    originIndex: 1,
  });
  const restored = restoreWaterfallSnapshot(snapshot),
    rect = { x: 120, y: 80, width: 1, height: 1 };
  assert.deepEqual(
    restored.commandsFor(rect).map((c) => [c.asset, c.dx, c.dy, c.originIndex]),
    [
      ["first", -8, 0, 1],
      ["Waterfall_25.png", 0, 0, 0],
      ["Waterfall_25.png", 0, 0, 0],
    ],
  );
  assert.equal(
    restoreWaterfallSnapshot({ ...snapshot, scanComplete: false }).hasOrigin(
      120,
      80,
    ),
    undefined,
  );
  assert.throws(
    () => restored.commandsFor({ x: 99, y: 70, width: 1, height: 1 }),
    /outside/,
  );
});

function nodeFactory(workers) {
  return () => {
    const worker = new NodeWorker(
        new URL("./helpers/waterfall-worker-node.mjs", import.meta.url),
        { type: "module" },
      ),
      callbacks = new Map();
    workers.push(worker);
    return {
      postMessage: (...args) => worker.postMessage(...args),
      terminate: () => worker.terminate(),
      addEventListener(type, fn) {
        const wrapped =
          type === "message"
            ? (data) => fn({ data })
            : (error) => fn({ message: error.message, preventDefault() {} });
        callbacks.set(fn, { type, wrapped });
        worker.on(type, wrapped);
      },
      removeEventListener(type, fn) {
        const found = callbacks.get(fn);
        if (found) {
          worker.off(type, found.wrapped);
          callbacks.delete(fn);
        }
      },
    };
  };
}
function syntheticWorld() {
  const width = 260,
    height = 260,
    changes = new Map([
      ["120,80", { type: 1, shape: 1 }],
      ["119,80", { type: null, liquid: 255, liquidKind: 4 }],
      ["140,80", { type: 1, shape: 1 }],
      ["139,80", { type: null, liquid: 255, liquidKind: 1 }],
      ["121,90", { type: 1 }],
    ]);
  const columns = Array.from({ length: width }, (_, x) => {
    const runs = [];
    let empty = 0;
    const flush = () => {
      if (empty) {
        runs.push(record({ type: null, repeats: empty - 1 }));
        empty = 0;
      }
    };
    for (let y = 0; y < height; y++) {
      const value = changes.get(`${x},${y}`);
      if (value) {
        flush();
        runs.push(record(value));
      } else empty++;
    }
    flush();
    return runs;
  });
  return fixtureWorld({ width, height, columns }).bytes;
}

test("real worker-thread protocol matches the direct registry, retains source cap and viewport-local scanning", async () => {
  const bytes = syntheticWorld(),
    before = [...bytes],
    workers = [],
    client = createWaterfallWorkerClient({
      workerFactory: nodeFactory(workers),
    });
  try {
    const init = await client.initialize(bytes, { revision: 7 });
    assert.equal(init.status, "ready");
    assert.equal(workers[0].threadId > 0, true);
    const world = openWorld(bytes),
      view = { x: 110, y: 75, width: 50, height: 30 },
      outputRect = { x: 108, y: 73, width: 54, height: 34 };
    const expected = createStaticWaterfallRegistry(
      {
        width: world.width,
        height: world.height,
        worldSurface: world.worldSurface,
        getTile: getWorldTileAccessor(world),
      },
      { viewport: view },
    );
    const actual = await client.requestSnapshot({
      revision: 7,
      requestId: 11,
      viewport: view,
      outputRect,
    });
    assert.equal(actual.status, "ready");
    assert.equal(actual.maxWaterfalls, 1000);
    assert.equal(actual.cap, 1000);
    assert.ok(
      actual.scan.width * actual.scan.height < world.width * world.height,
    );
    assert.deepEqual(actual.origins, expected.origins);
    assert.deepEqual(actual.commands, expected.commandsFor(outputRect));
    assert.deepEqual(actual.failures, expected.failures);
    assert.deepEqual(actual.requiredAssets, expected.requiredAssets);
    assert.deepEqual(actual.commandsFor(view), expected.commandsFor(view));
    assert.equal(actual.hasOrigin(120, 80), true);
    assert.equal(actual.hasOrigin(140, 80), true);
    assert.deepEqual([...bytes], before);
    await assert.rejects(
      client.requestSnapshot({
        revision: 7,
        requestId: 12,
        viewport: { x: 250, y: 250, width: 20, height: 20 },
      }),
      /rectangle/,
    );
    const again = await client.requestSnapshot({
      revision: 7,
      requestId: 13,
      viewport: view,
      options: { maxWaterfalls: 1 },
    });
    assert.equal(again.origins.length, 1);
    assert.equal(again.stats.capped, 1);
  } finally {
    client.terminate();
  }
});

const fixture = new URL("../fixtures/example-world.wld", import.meta.url);
test(
  "actual saved world computes a fresh viewport snapshot off thread while main-thread timers keep running",
  { skip: !existsSync(fixture) },
  async () => {
    const bytes = readFileSync(fixture),
      hash = createHash("sha256").update(bytes).digest("hex"),
      workers = [],
      client = createWaterfallWorkerClient({
        workerFactory: nodeFactory(workers),
      });
    let ticks = 0,
      timer = setInterval(() => ticks++, 1);
    try {
      const init = await client.initialize(bytes, { revision: 17 });
      const beforeTicks = ticks;
      const snapshot = await client.requestSnapshot({
        revision: 17,
        requestId: 1,
        viewport: { x: 4358, y: 225, width: 84, height: 64 },
      });
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.maxWaterfalls, 1000);
      assert.equal(snapshot.scan.width * snapshot.scan.height, 53669);
      assert.ok(ticks > beforeTicks);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
      const output = new URL("../artifacts/waterfall-worker/", import.meta.url);
      mkdirSync(output, { recursive: true });
      writeFileSync(
        new URL("actual-viewport.json", output),
        JSON.stringify(
          {
            worldSha256: hash,
            world: init.world,
            parseMs: init.parseMs,
            viewport: snapshot.viewport,
            scan: snapshot.scan,
            computeMs: snapshot.computeMs,
            stats: snapshot.stats,
            returnedCommands: snapshot.commands.length,
            requiredAssets: snapshot.requiredAssets,
            failures: snapshot.failures,
            timerTicksDuringScan: ticks - beforeTicks,
            defaultMaxWaterfalls: snapshot.maxWaterfalls,
          },
          null,
          2,
        ),
      );
    } finally {
      clearInterval(timer);
      client.terminate();
    }
  },
);

test("an unresponsive physical scan times out even after supersession and releases its pending viewport", async () => {
  const workers = [],
    client = createWaterfallWorkerClient({
      workerFactory: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      timeoutMs: 20,
    });
  const init = client.initialize(Uint8Array.of(1), { revision: 1 });
  workers[0].ready(1);
  await init;
  const first = client.requestSnapshot(request(1)),
    latest = client.requestSnapshot(request(2));
  assert.equal((await first).reason, "superseded");
  await assert.rejects(latest, (error) => error.code === "worker-timeout");
  assert.equal(client.getState().state, "failed");
  assert.equal(workers[0].terminated, 1);
  client.dispose();
  const cold = createWaterfallWorkerClient({
    workerFactory: () => new FakeWorker(),
    timeoutMs: 10,
  });
  await assert.rejects(
    cold.initialize(Uint8Array.of(1), { revision: 1 }),
    (error) => error.code === "worker-timeout",
  );
  cold.dispose();
});
