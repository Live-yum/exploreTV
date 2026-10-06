import { createWaterfallWorkerClient } from "/core/waterfall-worker-client.mjs";
import { sceneFrameReservedBytes } from "/core/scene-batches.mjs";
import {
  openWorld,
  extractRegion,
  getWorldTileAccessor,
  cellAt,
  LIMITS,
} from "/core/world.mjs";
import { loadWorldEngine, worldWasmStats } from "/core/world-wasm.mjs";
import { planScene, renderScene } from "/core/renderer.mjs";
import { prepareSceneFrames, sceneFrameKey } from "/core/scene-frames.mjs";
import {
  inspectPng,
  registerTextureSource,
  textureMemoryBytes,
  ASSET_LIMITS,
} from "/core/assets.mjs";
import { decodePngRgba } from "/core/png-rgba.mjs";
import {
  VIEWPORT_LIMITS,
  viewportSize,
  clampCamera,
  panCamera,
  zoomCamera,
  jumpCamera,
  viewportRegion,
  screenToWorld,
  insideRect,
  visibleCommands,
  ByteLruCache,
  LatestRenderQueue,
} from "/core/viewport.mjs";

const jsWorldEngine = Object.freeze({
  backend: "javascript",
  openWorld,
  extractRegion,
  disposeWorld() {},
});
let worldEngine = jsWorldEngine,
  worldEnginePromise;
let waterfallClient = null,
  waterfallRequestId = 0;
let pendingWorldInstall = null;
function releasePendingWorld(candidate) {
  if (!candidate || candidate.released) return;
  candidate.released = true;
  candidate.client.terminate();
  candidate.engine.disposeWorld(candidate.world);
  if (pendingWorldInstall === candidate) pendingWorldInstall = null;
}
function cancelPendingWorld() {
  releasePendingWorld(pendingWorldInstall);
}

function getWorldEngine() {
  // A deterministic JS mode is retained for equivalence tests and diagnostics.
  if (new URL(location.href).searchParams.get("engine") === "javascript")
    return Promise.resolve(jsWorldEngine);
  return (worldEnginePromise ??= loadWorldEngine());
}
const $ = (id) => document.getElementById(id);
const viewport = $("viewport"),
  canvas = $("world-canvas");
const createCanvas = (width, height) =>
  Object.assign(document.createElement("canvas"), { width, height });
const staging = createCanvas(1, 1),
  committed = createCanvas(1, 1);
const textureName =
  /^(?:(?:Tiles_|Wall_|water_|Tree_Tops_|Tree_Branches_|Glow_|Liquid_|Flame_|LiquidSlope_|Waterfall_|Extra_)\d+|SunAltar|SunOrb)\.png$/;
let world = null,
  camera = { x: 0, y: 0, zoom: 1 },
  size = { width: 1, height: 1 };
let source = makeSource(),
  worldRevision = 0,
  installedWorldRevision = 0,
  installedLoadStarted = 0,
  activeAbort = null,
  scheduled = false,
  lastResult = null;
const queue = new LatestRenderQueue(drawViewport, commitViewport, (error) => {
  viewport.dataset.busy = "false";
  status(error.message, true);
});
function makeSource() {
  return {
    files: new Map(),
    manifest: new Map(),
    cache: new ByteLruCache(),
    failures: new Map(),
    fetched: new Set(),
    active: true,
  };
}
function status(message, error = false) {
  $("load-status").textContent = message;
  $("load-status").classList.toggle("error", error);
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
async function readResponse(url, maxBytes, signal) {
  const response = await fetch(url, { signal, cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw new Error(`${url}: 文件超出大小限制`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("文件超出大小限制");
    return bytes;
  }
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new Error("文件超出大小限制");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
function parseManifest(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.textures) ||
    manifest.textures.length > ASSET_LIMITS.manifestCount
  )
    throw new Error("示例贴图清单格式无效");
  const entries = new Map();
  for (const entry of manifest.textures) {
    if (
      !textureName.test(entry.file) ||
      entries.has(entry.file) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 24 ||
      entry.bytes > ASSET_LIMITS.encodedBytes ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256)
    )
      throw new Error("示例贴图清单条目无效");
    entries.set(entry.file, entry);
  }
  if (
    !["tconvert-game-raw", "standard-straight"].includes(manifest.inputEncoding)
  )
    throw new Error("未知 PNG 通道编码");
  return entries;
}
async function imageFromBytes(bytes, info) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("PNG 解码超时")),
        15000,
      );
      const finish = (error) => {
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        error ? reject(error) : resolve();
      };
      image.onload = () =>
        finish(
          image.naturalWidth !== info.width ||
            image.naturalHeight !== info.height
            ? new Error("PNG 解码尺寸与文件头不符")
            : null,
        );
      image.onerror = () => finish(new Error("PNG 解码失败"));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function assetFor(name, selectedSource, current, signal) {
  const cached = selectedSource.cache.get(name);
  if (cached) return cached;
  if (selectedSource.failures.has(name)) return null;
  const file = selectedSource.files.get(name),
    entry = selectedSource.manifest.get(name);
  if (!file && !entry) {
    selectedSource.failures.set(name, "缺少贴图");
    return null;
  }
  try {
    let bytes;
    if (file) {
      if (file.size > ASSET_LIMITS.encodedBytes)
        throw new Error("PNG 文件超出 8 MiB");
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = await readResponse(
        `/example/assets/${name}`,
        ASSET_LIMITS.encodedBytes,
        signal,
      );
      selectedSource.fetched.add(name);
      if (
        bytes.length !== entry.bytes ||
        (await digest(bytes)) !== entry.sha256.toLowerCase()
      )
        throw new Error("PNG 大小或 SHA-256 与清单不符");
    }
    if (!current()) return null;
    const info = inspectPng(bytes);
    // Evict before decoding. A current draw batch owns only this one source atlas.
    selectedSource.cache.reserve(bytes.length + info.decodedBytes * 2);
    let rawRgba = null,
      rawError = null;
    try {
      rawRgba = decodePngRgba(bytes);
    } catch (error) {
      rawError = `raw-png-unsupported: ${error.message}`;
    }
    if (!current()) return null;
    const image = await imageFromBytes(bytes, info);
    if (!current() || !selectedSource.active) return null;
    registerTextureSource(image, { pngBytes: bytes, rawRgba, rawError });
    return selectedSource.cache.set(name, image, textureMemoryBytes(image));
  } catch (error) {
    if (!current() || signal.aborted) return null;
    selectedSource.failures.set(name, error.message);
    return null;
  }
}
function* commandBatches(commands) {
  let batch = [],
    keys = new Set(),
    bytes = 0,
    asset = null;
  for (const command of commands) {
    const key = sceneFrameKey(command),
      extra = keys.has(key) ? 0 : sceneFrameReservedBytes(command);
    if (
      batch.length &&
      (asset !== command.asset ||
        batch.length >= 2048 ||
        (!keys.has(key) && keys.size >= 450) ||
        bytes + extra > 7 * 1024 * 1024)
    ) {
      yield batch;
      batch = [];
      keys = new Set();
      bytes = 0;
    }
    asset = command.asset;
    if (!keys.has(key)) {
      keys.add(key);
      bytes += extra;
    }
    batch.push(command);
  }
  if (batch.length) yield batch;
}
async function drawViewport(request, current) {
  if (!current()) return null;
  const started = performance.now();
  const {
    selectedWorld,
    selectedSource,
    selectedWaterfallClient,
    worldRevision: requestWorldRevision,
    camera: nextCamera,
    size: nextSize,
    encoding,
  } = request;
  const view = viewportRegion(nextCamera, selectedWorld, nextSize);
  const region = worldEngine.extractRegion(selectedWorld, view.context);
  region.treeContext = selectedWorld.treeContext;
  region.herbContext = selectedWorld.herbContext;
  region.treeContextUnavailableReason =
    selectedWorld.treeContextUnavailableReason;
  region.getWorldTile = getWorldTileAccessor(selectedWorld);
  const waterfallRegistry = await selectedWaterfallClient.requestSnapshot({
    revision: requestWorldRevision,
    requestId: ++waterfallRequestId,
    viewport: view.rect,
    outputRect: region.rect,
    options: {
      quality: 1,
      maxWaterfalls: 1000,
      waterStyle: 0,
      frame: 0,
      slowFrame: 0,
    },
  });
  if (!current() || waterfallRegistry.status === "discarded") return null;
  if (!waterfallRegistry.scanComplete || waterfallRegistry.failures.length)
    throw new Error("瀑布静态快照存在未解决依赖，保留上一帧；请查看支持范围。");
  const fullPlan = planScene(region, {
    paintEnabled: true,
    liquids: {
      enabled: true,
      layer: "foreground",
      waterStyle: 0,
      waterfallRegistry,
    },
  });
  const commands = visibleCommands(fullPlan, region.rect, nextCamera, nextSize);
  const plan = { ...fullPlan, commands };
  const omissions = new Map(),
    reasons = new Map(),
    missing = new Set(),
    unsupportedTypes = new Map();
  const mark = (x, y, flag, reason) => {
    if (!insideRect(x, y, view.rect)) return;
    const key = `${x},${y}`;
    const entry = omissions.get(key) || { x, y, flags: 0 };
    entry.flags |= flag;
    omissions.set(key, entry);
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  };
  for (const cell of fullPlan.unsupportedCells)
    if (insideRect(cell.x, cell.y, view.rect)) {
      mark(cell.x, cell.y, 1, "未支持 Tile");
      unsupportedTypes.set(
        cell.type,
        (unsupportedTypes.get(cell.type) || 0) + 1,
      );
    }
  for (const cell of fullPlan.support.liquidDrawing.unsupportedCoordinates)
    mark(cell.x, cell.y, 2, `液体 ${cell.reason}`);
  let activeTiles = 0;
  for (let x = view.rect.x; x < view.rect.x + view.rect.width; x++)
    for (let y = view.rect.y; y < view.rect.y + view.rect.height; y++) {
      const cell = cellAt(region, x - region.rect.x, y - region.rect.y);
      if (cell.active && !cell.invisibleBlock) activeTiles++;
    }
  staging.width = nextSize.width;
  staging.height = nextSize.height;
  const context = staging.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, staging.width, staging.height);
  context.imageSmoothingEnabled = false;
  context.scale(nextCamera.zoom, nextCamera.zoom);
  context.translate(
    region.rect.x * 16 - nextCamera.x,
    region.rect.y * 16 - nextCamera.y,
  );
  const controller = new AbortController();
  activeAbort = controller;
  let drawn = 0,
    skipped = 0,
    batches = 0,
    preparedBytes = 0;
  const fetchedBefore = selectedSource.fetched.size;
  for (const batch of commandBatches(commands)) {
    if (!current()) return null;
    const asset = await assetFor(
      batch[0].asset,
      selectedSource,
      current,
      controller.signal,
    );
    if (!current()) return null;
    const valid = [];
    for (const command of batch) {
      const wx = region.rect.x + command.x,
        wy = region.rect.y + command.y;
      if (!asset) {
        missing.add(command.asset);
        mark(wx, wy, 4, "缺少或无效贴图");
        skipped++;
        continue;
      }
      if (
        command.sx < 0 ||
        command.sy < 0 ||
        command.sx + command.sw > asset.naturalWidth ||
        command.sy + command.sh > asset.naturalHeight
      ) {
        mark(wx, wy, 8, "贴图裁切超出范围");
        skipped++;
        continue;
      }
      valid.push(command);
    }
    if (valid.length) {
      const assets = new Map([[batch[0].asset, asset]]),
        part = { ...plan, commands: valid, warnings: [] };
      const frames = prepareSceneFrames(part, assets, createCanvas, {
        inputEncoding: encoding,
        opaqueScene: true,
      });
      preparedBytes = Math.max(preparedBytes, frames.support.bytes);
      try {
        const drawable = valid.filter((command) => {
          const frame = frames.resolve(command);
          if (!frame?.unsupported) return true;
          mark(
            region.rect.x + command.x,
            region.rect.y + command.y,
            16,
            `通道/染色 ${frame.unsupported}`,
          );
          skipped++;
          return false;
        });
        const result = renderScene(
          context,
          { ...part, commands: drawable },
          assets,
          { strict: true, sceneFrames: { ...frames, opaqueScene: false } },
        );
        drawn += result.drawn;
      } finally {
        frames.dispose();
      }
    }
    if (++batches % 8 === 0) await pause();
  }
  if (!current()) return null;
  return {
    view,
    omissions: [...omissions.values()],
    reasons: [...reasons],
    missing: [...missing],
    unsupportedTypes: [...unsupportedTypes],
    drawn,
    skipped,
    activeTiles,
    planned: commands.length,
    decodedTiles: region.cells.length,
    renderMs: performance.now() - started,
    waterfallScanMs: waterfallRegistry.computeMs,
    waterfallOrigins: waterfallRegistry.origins.length,
    preparedBytes,
    cacheBytes: selectedSource.cache.bytes,
    cachePeakBytes: selectedSource.cache.peakBytes,
    fetchedAssets: selectedSource.fetched.size,
    newAssets: selectedSource.fetched.size - fetchedBefore,
    warnings: fullPlan.warnings,
    sourceFailures: [...selectedSource.failures].filter(([name]) =>
      missing.has(name),
    ),
  };
}
function paintResult(result) {
  canvas.width = result.view.size.width;
  canvas.height = result.view.size.height;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.drawImage(committed, 0, 0);
  if ($("show-coverage").checked) {
    const { camera: viewCamera } = result.view;
    for (const cell of result.omissions) {
      const x = (cell.x * 16 - viewCamera.x) * viewCamera.zoom,
        y = (cell.y * 16 - viewCamera.y) * viewCamera.zoom,
        side = 16 * viewCamera.zoom;
      const color =
        cell.flags & 28
          ? "255,85,85"
          : cell.flags & 1
            ? "231,78,234"
            : "255,185,51";
      context.fillStyle = `rgba(${color},0.32)`;
      context.fillRect(x, y, side, side);
      context.strokeStyle = `rgba(${color},0.95)`;
      context.lineWidth = Math.max(1, viewCamera.zoom);
      context.beginPath();
      context.moveTo(x + 2, y + 2);
      context.lineTo(x + side - 2, y + side - 2);
      context.moveTo(x + side - 2, y + 2);
      context.lineTo(x + 2, y + side - 2);
      context.stroke();
    }
  }
}
function commitViewport(result, request, revision) {
  if (!result) return;
  lastResult = result;
  committed.width = staging.width;
  committed.height = staging.height;
  committed.getContext("2d").drawImage(staging, 0, 0);
  paintResult(result);
  const { rect, context, size: viewSize, camera: viewCamera } = result.view;
  const unsupported = result.unsupportedTypes.reduce(
    (sum, [, count]) => sum + count,
    0,
  );
  viewport.dataset.busy = "false";
  if (!viewport.dataset.firstViewportMs) viewport.dataset.firstViewportMs = String(performance.now()-installedLoadStarted);
  Object.assign(viewport.dataset, {
    revision: String(revision),
    cameraX: String(viewCamera.x),
    cameraY: String(viewCamera.y),
    zoom: String(viewCamera.zoom),
    roi: JSON.stringify(rect),
    context: JSON.stringify(context),
    decodedTiles: String(result.decodedTiles),
    canvasPixels: String(viewSize.width * viewSize.height),
    cacheBytes: String(result.cacheBytes),
    cachePeakBytes: String(result.cachePeakBytes),
    fetchedAssets: String(result.fetchedAssets),
    drawn: String(result.drawn),
    skipped: String(result.skipped),
    omissions: String(result.omissions.length),
    waterfallBackend: "worker",
    waterfallScanMs: String(result.waterfallScanMs),
    waterfallOrigins: String(result.waterfallOrigins),
    unsupported: String(unsupported),
    worldWidth: String(world.width),
    worldHeight: String(world.height),
  });
  $("zoom-reset").textContent = `${Math.round(viewCamera.zoom * 100)}%`;
  $("view-metrics").textContent =
    `X ${rect.x}–${rect.x + rect.width - 1} · Y ${rect.y}–${rect.y + rect.height - 1}  |  ${rect.width} × ${rect.height} Tile  |  ${Math.round(viewCamera.zoom * 100)}% · ${+(16 * viewCamera.zoom).toFixed(2)} px / Tile`;
  $("coverage-summary").textContent =
    `当前视口：${result.activeTiles.toLocaleString()} 个可见前景 Tile · ${result.drawn.toLocaleString()} 个贴图片段 · ${result.omissions.length.toLocaleString()} 个单元有缺项`;
  $("coverage").classList.toggle("has-gaps", result.omissions.length > 0);
  $("diagnostic-text").textContent = [
    `解析引擎：${worldEngine.backend}；主索引解析 ${Number(viewport.dataset.openMs || 0).toFixed(1)} ms`,
    `辅助线程解析 ${Number(viewport.dataset.waterfallParseMs || 0).toFixed(1)} ms；本次瀑布扫描 ${Number(result.waterfallScanMs || 0).toFixed(1)} ms；首次可见画面 ${Number(viewport.dataset.firstViewportMs || 0).toFixed(1)} ms（含读取、线程和贴图处理）`,
    ...(worldEngine.fallbackReason
      ? [`WASM 未启用：${worldEngine.fallbackReason}`]
      : []),
    `源世界：${world.width} × ${world.height} Tile；逻辑画布：${world.width * 16} × ${world.height * 16} px`,
    `屏幕 Canvas：${viewSize.width} × ${viewSize.height} px；100% = 原始 16 px / Tile`,
    `本次解码（含 ${VIEWPORT_LIMITS.halo} Tile 边界上下文）：${result.decodedTiles.toLocaleString()} / ${VIEWPORT_LIMITS.regionTiles.toLocaleString()} Tile`,
    `贴图缓存（PNG + raw RGBA + 图像）：${(result.cacheBytes / 1048576).toFixed(2)} / 48 MiB；本次临时帧峰值 ${(result.preparedBytes / 1048576).toFixed(2)} MiB`,
    `按需获取示例贴图：${result.fetchedAssets} 张；本次新增 ${result.newAssets} 张`,
    `绘制 ${result.drawn} / ${result.planned} 个计划片段；缺项 ${result.skipped}；${Math.round(result.renderMs)} ms`,
    `未支持 Tile：${unsupported}${unsupported ? "（ID:数量 " + result.unsupportedTypes.map((pair) => pair.join(":")).join(", ") + "）" : ""}`,
    ...result.reasons.map(([reason, count]) => `${reason}: ${count}`),
    ...(result.missing.length
      ? [`Missing textures: ${result.missing.join(", ")}`]
      : []),
    ...result.sourceFailures.map(([name, reason]) => `${name}: ${reason}`),
    "",
    "以下计数描述含边界上下文的规划区；上方缺项计数仅描述当前视口：",
    ...result.warnings,
  ].join("\n");
  status(
    result.omissions.length
      ? `已绘制 · ${result.omissions.length} 个缺项单元`
      : "已绘制 · 当前视口无已知缺项",
  );
  if (result.missing.length) $("diagnostics").open = true;
  $("empty-state").hidden = true;
}
function scheduleRender() {
  if (!world) return;
  activeAbort?.abort();
  queue.invalidate();
  viewport.dataset.busy = "true";
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!world) return;
    camera = clampCamera(camera, world, size);
    queue.request({
      selectedWorld: world,
      selectedSource: source,
      selectedWaterfallClient: waterfallClient,
      worldRevision: installedWorldRevision,
      camera: { ...camera },
      size: { ...size },
      encoding: $("encoding").value,
    });
  });
}
function resize() {
  size = viewportSize(viewport.clientWidth, viewport.clientHeight);
  if (world) {
    camera = clampCamera(camera, world, size);
    scheduleRender();
  } else {
    canvas.width = size.width;
    canvas.height = size.height;
  }
}
async function installWorld(
  bytes,
  selectedSource,
  { example = false, revision = worldRevision, encoding, loadStarted = performance.now() } = {},
) {
  const engine = await getWorldEngine();
  if (revision !== worldRevision) return;
  const openedAt = performance.now();
  const parsed = engine.openWorld(bytes);
  const openMs = performance.now() - openedAt;
  cancelPendingWorld();
  const candidate = {
    client: createWaterfallWorkerClient(),
    world: parsed,
    engine,
    released: false,
  };
  pendingWorldInstall = candidate;
  try {
    const ready = await candidate.client.initialize(bytes, { revision });
    candidate.parseMs = ready.parseMs;
    if (
      revision !== worldRevision ||
      ready.status !== "ready" ||
      pendingWorldInstall !== candidate
    ) {
      releasePendingWorld(candidate);
      return;
    }
  } catch (error) {
    releasePendingWorld(candidate);
    throw error;
  }
  pendingWorldInstall = null;
  waterfallClient?.terminate();
  waterfallClient = candidate.client;
  installedWorldRevision = revision;
  installedLoadStarted = loadStarted;
  viewport.dataset.firstViewportMs = "";
  viewport.dataset.waterfallParseMs = String(candidate.parseMs);
  if (encoding !== undefined) $("encoding").value = encoding;
  const previous = world;
  worldEngine = engine;
  if (previous) engine.disposeWorld(previous);
  viewport.dataset.backend = engine.backend;
  viewport.dataset.openMs = String(openMs);
  viewport.dataset.wasmMemoryBytes = String(
    worldWasmStats(parsed)?.memoryBytes || 0,
  );
  viewport.dataset.fallbackReason = engine.fallbackReason || "";
  source.active = false;
  source.cache.clear();
  source = selectedSource;
  source.active = true;
  world = parsed;
  camera = { x: 0, y: 0, zoom: 1 };
  const x = example
    ? Math.min(4489, world.width - 1)
    : Math.floor(world.width / 2);
  const y = example
    ? Math.min(489, world.height - 1)
    : Math.min(
        world.height - 1,
        Math.max(0, Math.floor(world.worldSurface || world.height / 2)),
      );
  camera = jumpCamera(camera, x, y, world, size);
  $("tile-x").max = String(world.width - 1);
  $("tile-y").max = String(world.height - 1);
  $("tile-x").value = String(x);
  $("tile-y").value = String(y);
  $("world-title").textContent = world.name;
  $("world-dimensions").textContent =
    `${world.width.toLocaleString()} × ${world.height.toLocaleString()} Tile · v${world.version}`;
  scheduleRender();
}
$("example").addEventListener("click", async () => {
  const revision = ++worldRevision;
  const loadStarted = performance.now();
  cancelPendingWorld();
  activeAbort?.abort();
  queue.invalidate();
  $("example").disabled = true;
  status("读取示例世界与贴图清单…");
  try {
    const [bytes, manifestBytes] = await Promise.all([
      readResponse("/fixtures/example-world.wld", LIMITS.fileBytes),
      readResponse("/example/asset-manifest.json", 256 * 1024),
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const selectedSource = makeSource();
    selectedSource.manifest = parseManifest(manifest);
    if (
      manifest.world?.sha256 &&
      (await digest(bytes)) !== manifest.world.sha256.toLowerCase()
    )
      throw new Error("示例世界 SHA-256 与清单不符");
    if (revision !== worldRevision) return;
    status("建立世界列索引…");
    await pause();
    if (revision === worldRevision)
      await installWorld(bytes, selectedSource, {
        example: true,
        revision,
        loadStarted,
        encoding: manifest.inputEncoding,
      });
  } catch (error) {
    if (revision === worldRevision) {
      status(error.message, true);
      viewport.dataset.busy = "false";
    }
  } finally {
    $("example").disabled = false;
  }
});
$("world-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const revision = ++worldRevision;
  const loadStarted = performance.now();
  cancelPendingWorld();
  activeAbort?.abort();
  queue.invalidate();
  status("读取世界文件，建立列索引…");
  try {
    if (file.size > LIMITS.fileBytes) throw new Error("世界文件超出 64 MiB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await pause();
    if (revision !== worldRevision) return;
    const selectedSource = makeSource();
    selectedSource.files = new Map(source.files);
    await installWorld(bytes, selectedSource, { revision, loadStarted });
  } catch (error) {
    if (revision === worldRevision) {
      status(error.message, true);
      viewport.dataset.busy = "false";
    }
  }
  event.target.value = "";
});
$("texture-files").addEventListener("change", (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  const next = new Map(source.files);
  for (const file of files)
    if (textureName.test(file.name)) next.set(file.name, file);
  if (next.size > ASSET_LIMITS.manifestCount) {
    status(`最多可导入 ${ASSET_LIMITS.manifestCount} 张命名贴图`, true);
    return;
  }
  source.files = next;
  source.failures.clear();
  source.cache.clear();
  status(`${next.size} 张贴图已选择，按视口需要解码`);
  scheduleRender();
  event.target.value = "";
});
$("encoding").addEventListener("change", scheduleRender);
$("show-coverage").addEventListener("change", () => {
  if (lastResult && viewport.dataset.busy === "false") paintResult(lastResult);
});
$("jump-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!world) return;
  try {
    camera = jumpCamera(
      camera,
      Number($("tile-x").value),
      Number($("tile-y").value),
      world,
      size,
    );
    scheduleRender();
  } catch (error) {
    status(error.message, true);
  }
});
function zoomTo(zoom, anchor = { x: size.width / 2, y: size.height / 2 }) {
  if (!world) return;
  camera = zoomCamera(camera, zoom, anchor, world, size);
  scheduleRender();
}
$("zoom-in").addEventListener("click", () => zoomTo(camera.zoom * 1.25));
$("zoom-out").addEventListener("click", () => zoomTo(camera.zoom / 1.25));
$("zoom-reset").addEventListener("click", () => zoomTo(1));
viewport.addEventListener(
  "wheel",
  (event) => {
    if (!world) return;
    event.preventDefault();
    const box = viewport.getBoundingClientRect();
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
    zoomTo(camera.zoom * Math.pow(2, -delta / 500), {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  },
  { passive: false },
);
let drag = null;
viewport.addEventListener("pointerdown", (event) => {
  if (!world || event.button !== 0) return;
  viewport.focus({ preventScroll: true });
  viewport.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  viewport.classList.add("dragging");
});
viewport.addEventListener("pointermove", (event) => {
  if (!world) return;
  if (drag?.id === event.pointerId) {
    camera = panCamera(
      camera,
      event.clientX - drag.x,
      event.clientY - drag.y,
      world,
      size,
    );
    drag.x = event.clientX;
    drag.y = event.clientY;
    scheduleRender();
  }
  const box = viewport.getBoundingClientRect(),
    position = screenToWorld(
      camera,
      event.clientX - box.left,
      event.clientY - box.top,
    );
  $("cursor-position").textContent =
    `X ${Math.min(world.width - 1, Math.max(0, Math.floor(position.x / 16)))} · Y ${Math.min(world.height - 1, Math.max(0, Math.floor(position.y / 16)))}`;
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
  viewport.addEventListener(name, () => {
    drag = null;
    viewport.classList.remove("dragging");
  });
viewport.addEventListener("keydown", (event) => {
  if (!world) return;
  const move = {
    ArrowLeft: [128, 0],
    ArrowRight: [-128, 0],
    ArrowUp: [0, 128],
    ArrowDown: [0, -128],
  }[event.key];
  if (move) {
    event.preventDefault();
    camera = panCamera(camera, ...move, world, size);
    scheduleRender();
  }
});
window.addEventListener("pagehide", (event) => {
  activeAbort?.abort();
  queue.invalidate();
  if (!event.persisted) {
    cancelPendingWorld();
    waterfallClient?.terminate();
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && world) scheduleRender();
});
new ResizeObserver(resize).observe(viewport);
resize();
