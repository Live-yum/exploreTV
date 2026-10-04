<template>
  <view class="page">
    <view class="eyebrow">EXPLORE TV · TECHNICAL PREVIEW</view>
    <view class="title">把建筑，留成一个片段。</view>
    <view class="intro"
      >导入世界，选定矩形，用真实贴图查看场景，再保存完整 Tile
      记录。预览是静态近似，不是完整游戏渲染。</view
    >
    <view class="steps"
      ><button role="button" @click="importWorld" :disabled="busy">
        1 导入 .wld</button
      ><button role="button" @click="importTextures" :disabled="busy">
        2 导入 PNG 贴图</button
      ><button role="button" @click="importFragment" :disabled="busy">
        打开已保存片段
      </button></view
    >
    <view class="card" v-if="worldInfo"
      ><view>{{ worldInfo }}</view
      ><view class="muted"
        >原始世界只读。范围采用左闭右开坐标；每格 16 游戏像素。</view
      ></view
    >
    <view class="card"
      ><view class="row"
        ><view
          v-for="key in ['x', 'y', 'width', 'height']"
          :key="key"
          class="field"
          ><text>{{ labels[key] }}</text
          ><input type="number" v-model="rect[key]" /></view></view
      ><view class="row"
        ><button
          role="button"
          @click="preview"
          :disabled="busy || (!world && !baseFragment)"
        >
          3 生成场景预览</button
        ><button
          role="button"
          @click="save"
          :disabled="busy || !region || !rangeMatches"
        >
          4 提取 / 保存 Tile
        </button></view
      ></view
    >
    <view class="card canvas-card"
      ><view class="row"
        ><text>场景预览 · {{ renderLabel }}</text
        ><text>{{ assetCount }} 张贴图已载入</text></view
      ><view class="row tools">
        <button
          role="button"
          @click="changeZoom(-0.25)"
          :disabled="busy || !region || zoom <= 0.25"
        >
          缩小
        </button>
        <text>{{ Math.round(zoom * 100) }}%</text>
        <button
          role="button"
          @click="changeZoom(0.25)"
          :disabled="busy || !region || zoom >= 2"
        >
          放大
        </button>
        <button role="button" @click="pan(-1, 0)" :disabled="busy || !world">
          向左
        </button>
        <button role="button" @click="pan(1, 0)" :disabled="busy || !world">
          向右
        </button>
        <button role="button" @click="pan(0, -1)" :disabled="busy || !world">
          向上
        </button>
        <button role="button" @click="pan(0, 1)" :disabled="busy || !world">
          向下
        </button>
      </view>
      <view class="muted"
        >在当前场景上拖动选择矩形，再点“生成场景预览”确认。缩放不改变 Tile
        范围。</view
      >
      <view
        id="selection-surface"
        class="selection-surface"
        :style="{ width: canvasWidth + 'px', height: canvasHeight + 'px' }"
        @mousedown.capture.stop="startSelection"
        @mousemove.capture.stop="moveSelection"
        @mouseup.capture.stop="endSelection"
        @mouseleave="endSelection"
        @touchstart.stop.prevent="startSelection"
        @touchmove.stop.prevent="moveSelection"
        @touchend.stop.prevent="endSelection"
        @touchcancel="cancelSelection"
      >
        <canvas
          id="scene"
          canvas-id="scene"
          type="2d"
          class="canvas"
          :style="{ width: canvasWidth + 'px', height: canvasHeight + 'px' }"
        />
        <view
          v-if="selection"
          class="selection-box"
          :style="selectionStyle"
        /> </view
      ><view v-if="!region" class="muted"
        >尚未生成场景。请导入 .wld 并选择矩形。</view
      ></view
    >
    <view class="card status" :class="{ error: hasError }">{{ status }}</view>
    <view class="card" v-if="warnings.length"
      ><view>渲染范围与缺失信息</view
      ><view class="warning" v-for="(warning, i) in warnings" :key="i">{{
        warning
      }}</view></view
    >
    <view class="foot"
      >贴图不随代码分发。请使用有权使用的
      Tiles_N.png、Wall_N.png。文件只在当前设备处理。保存包含 Tile
      字段，不含箱子物品、告示牌文本、实体或 NPC；不会写回
      .wld。跨边界家具按矩形截断，请扩大范围保留完整家具。</view
    >
  </view>
</template>
<script setup>
import { ref, computed, shallowRef, onMounted, getCurrentInstance } from "vue";
import { rectangleFromDrag, moveRectangle } from "../../core/selection.mjs";
import { decodeUtf8 } from "../../core/utf8.mjs";
import { openWorld, extractRegion } from "../../core/world.mjs";
import {
  saveFragment,
  loadFragment,
  cropFragment,
} from "../../core/fragment.mjs";
import { planScene, renderScene } from "../../core/renderer.mjs";
import {
  chooseFiles,
  readBytes,
  saveText,
  loadTexture,
} from "../../adapters/files.js";
const instance = getCurrentInstance();
const baseFragment = shallowRef(null);
const world = shallowRef(null),
  region = shallowRef(null),
  worldInfo = ref(""),
  busy = ref(false),
  hasError = ref(false),
  status = ref("开始前：准备 .wld 世界存档和合法来源的游戏 PNG 贴图。"),
  warnings = ref([]),
  assetCount = ref(0),
  renderLabel = ref("等待导入"),
  canvasWidth = ref(320),
  canvasHeight = ref(200);
const rangeMatches = computed(
  () =>
    region.value &&
    Object.keys(region.value.rect).every(
      (k) => Number(rect.value[k]) === region.value.rect[k],
    ),
);
const labels = {
  x: "起点 X",
  y: "起点 Y",
  width: "宽度（格）",
  height: "高度（格）",
};
const zoom = ref(1),
  selection = ref(null);
let dragState = null,
  lastTouchAt = 0;
const rect = ref({ x: 0, y: 0, width: 64, height: 40 });
const selectionStyle = computed(() => {
  if (!selection.value || !region.value) return {};
  const a = selection.value,
    b = region.value.rect;
  return {
    left: ((a.x - b.x) / b.width) * canvasWidth.value + "px",
    top: ((a.y - b.y) / b.height) * canvasHeight.value + "px",
    width: (a.width / b.width) * canvasWidth.value + "px",
    height: (a.height / b.height) * canvasHeight.value + "px",
  };
});
let canvas, ctx;
const assets = new Map();
async function task(fn) {
  if (busy.value) return;
  busy.value = true;
  hasError.value = false;
  try {
    await fn();
  } catch (e) {
    hasError.value = true;
    status.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}
async function initCanvas() {
  // #ifdef H5
  const host = document.getElementById("scene");
  canvas = host?.querySelector("canvas") || host;
  ctx = canvas?.getContext("2d");
  // #endif
  // #ifdef MP-WEIXIN
  await new Promise((resolve) =>
    uni
      .createSelectorQuery()
      .in(instance.proxy)
      .select("#scene")
      .fields({ node: true, size: true })
      .exec((res) => {
        canvas = res[0]?.node;
        ctx = canvas?.getContext("2d");
        resolve();
      }),
  );
  // #endif
  if (!ctx) throw new Error("Canvas 2D 未就绪");
}
onMounted(() =>
  initCanvas().catch((e) => {
    status.value = e.message;
  }),
);
function importWorld() {
  return task(async () => {
    const [file] = await chooseFiles();
    if (!file) return;
    const next = openWorld(await readBytes(file));
    world.value = next;
    baseFragment.value = null;
    region.value = null;
    selection.value = null;
    zoom.value = 1;
    warnings.value = [];
    worldInfo.value = `${next.name} · v${next.version} · ${next.width} × ${next.height}`;
    rect.value = {
      x: Math.max(0, Math.floor(next.width / 2) - 32),
      y: Math.max(0, Math.floor(next.height / 3) - 20),
      width: Math.min(64, next.width),
      height: Math.min(40, next.height),
    };
    status.value =
      "文件头与 Tile 数据段已验证，已建立按列索引。调整坐标后生成预览。";
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
}
function importTextures() {
  return task(async () => {
    if (!canvas) await initCanvas();
    const files = await chooseFiles({ multiple: true, accept: ".png" });
    for (const file of files) {
      const name = file.name?.split("/").pop();
      if (!/^(Tiles|Wall)_\d+\.png$/.test(name)) continue;
      if (assets.size >= 256 && !assets.has(name))
        throw new Error("贴图缓存达到 256 张上限，请重开页面释放");
      const image = await loadTexture(file, canvas);
      const bytes =
        [...assets].reduce(
          (sum, [key, value]) =>
            sum + (key === name ? 0 : value.width * value.height * 4),
          0,
        ) +
        image.width * image.height * 4;
      if (bytes > 48 * 1024 * 1024) throw new Error("贴图缓存超过 48 MiB 限制");
      assets.set(name, image);
      assetCount.value = assets.size;
    }
    assetCount.value = assets.size;
    status.value = `已载入 ${assets.size} 张真实贴图。`;
    if (region.value) await draw();
  });
}
async function draw() {
  if (!canvas) await initCanvas();
  const plan = planScene(region.value);
  const scale = zoom.value * Math.min(1, 720 / plan.width, 480 / plan.height);
  canvasWidth.value = Math.max(1, Math.round(plan.width * scale));
  canvasHeight.value = Math.max(1, Math.round(plan.height * scale));
  canvas.width = canvasWidth.value;
  canvas.height = canvasHeight.value;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, plan.width, plan.height);
  const result = renderScene(ctx, plan, assets);
  warnings.value = [...(result.warnings || [])];
  if (plan.unsupportedCells?.length)
    warnings.value.push(
      "未绘制对象坐标（前32格）：" +
        plan.unsupportedCells
          .slice(0, 32)
          .map((t) => `类型${t.type}@(${t.x},${t.y})`)
          .join("；"),
    );
  warnings.value.push(
    "本预览未实现完整光照/动态效果。保存仅保留原始 Tile 数据，不代表画面完整，也不含箱子物品等附属数据。",
  );
  if (result.missingAssets?.length)
    warnings.value.push("缺少贴图：" + result.missingAssets.join(", "));
  renderLabel.value = `${region.value.rect.width} × ${region.value.rect.height} 格 · (${region.value.rect.x}, ${region.value.rect.y}) · 静态近似`;
  status.value = `已绘制 ${result.drawn || 0} 个贴图片段。${result.missingAssets.length || plan.support.unsupportedTiles || plan.support.liquid ? "预览不完整，请查看下方缺失信息。" : ""}缺失内容不会用地图色块替代。`;
}
function preview() {
  return task(async () => {
    const r = Object.fromEntries(
      Object.entries(rect.value).map(([k, v]) => [k, Number(v)]),
    );
    region.value = world.value
      ? extractRegion(world.value, r)
      : cropFragment(baseFragment.value, r);
    selection.value = null;
    await draw();
  });
}
function changeZoom(delta) {
  return task(async () => {
    zoom.value = Math.max(0.25, Math.min(2, zoom.value + delta));
    await draw();
  });
}
function pan(dx, dy) {
  return task(async () => {
    const r =
      region.value?.rect ||
      Object.fromEntries(
        Object.entries(rect.value).map(([k, v]) => [k, Number(v)]),
      );
    rect.value = moveRectangle(
      r,
      dx * Math.max(1, Math.floor(r.width / 2)),
      dy * Math.max(1, Math.floor(r.height / 2)),
      world.value.width,
      world.value.height,
    );
    region.value = extractRegion(world.value, rect.value);
    selection.value = null;
    await draw();
  });
}
function eventPosition(event) {
  const p = event.touches?.[0] || event.changedTouches?.[0] || event;
  return {
    x: Number(p.clientX ?? p.x ?? event.detail?.x),
    y: Number(p.clientY ?? p.y ?? event.detail?.y),
  };
}
async function startSelection(event) {
  if (busy.value || !region.value) return;
  if (event.type?.startsWith("touch")) lastTouchAt = Date.now();
  else if (Date.now() - lastTouchAt < 500) return;
  let bounds;
  // #ifdef H5
  bounds = document.getElementById("selection-surface").getBoundingClientRect();
  // #endif
  // #ifdef MP-WEIXIN
  bounds = await new Promise((resolve) =>
    uni
      .createSelectorQuery()
      .in(instance.proxy)
      .select("#selection-surface")
      .boundingClientRect(resolve)
      .exec(),
  );
  // #endif
  if (!bounds) return;
  const p = eventPosition(event);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  dragState = {
    bounds,
    start: { x: p.x - bounds.left, y: p.y - bounds.top },
    view: { ...region.value.rect },
  };
  moveSelection(event);
}
function moveSelection(event) {
  if (!dragState) return;
  const p = eventPosition(event);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  selection.value = rectangleFromDrag(
    dragState.start,
    { x: p.x - dragState.bounds.left, y: p.y - dragState.bounds.top },
    dragState.view,
    dragState.bounds.width,
    dragState.bounds.height,
  );
}
function endSelection(event) {
  if (!dragState) return;
  moveSelection(event);
  dragState = null;
  if (selection.value) {
    rect.value = { ...selection.value };
    status.value = `已选择 (${rect.value.x}, ${rect.value.y})，${rect.value.width} × ${rect.value.height} 格。请重新生成预览后保存。`;
  }
}
function cancelSelection() {
  dragState = null;
  selection.value = null;
}
function save() {
  return task(async () => {
    if (!rangeMatches.value) throw new Error("范围已改变，请重新预览");
    const text = saveFragment(region.value),
      check = loadFragment(text);
    if (check.raw.length !== region.value.raw.length)
      throw new Error("恢复校验失败");
    const name = `building-${region.value.rect.x}-${region.value.rect.y}-${Date.now()}.tvtiles.json`,
      path = await saveText(text, name);
    status.value = `已保存并重新读取验证 ${check.raw.length} 个 Tile：${path}。CRC32 为损坏检测，不是安全签名。`;
  });
}
function importFragment() {
  return task(async () => {
    const [file] = await chooseFiles({ accept: ".json" });
    if (!file) return;
    region.value = loadFragment(
      decodeUtf8(await readBytes(file, 16 * 1024 * 1024)),
    );
    world.value = null;
    baseFragment.value = region.value;
    worldInfo.value = `已保存片段 · ${region.value.source.name} · v${region.value.version}`;
    rect.value = { ...region.value.rect };
    selection.value = null;
    await draw();
  });
}
</script>
<style scoped>
.page {
  max-width: 1000px;
  margin: auto;
  padding: 24px 18px;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 3px;
  color: #89d4c6;
}
.title {
  font-size: 32px;
  font-weight: 700;
  margin: 14px 0;
}
.intro {
  max-width: 680px;
  line-height: 1.7;
  color: #bac7da;
}
.steps,
.row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.steps {
  margin: 24px 0;
}
.steps button,
.row button {
  margin: 0;
  background: #86d8c7;
  color: #102b30;
}
.card {
  background: #172338;
  border: 1px solid #2d3f57;
  border-radius: 14px;
  padding: 18px;
  margin: 14px 0;
}
.field {
  flex: 1;
  min-width: 100px;
}
.field text {
  font-size: 12px;
  color: #b5c4d8;
}
.field input {
  margin: 6px 0 16px;
}
.muted,
.foot {
  font-size: 12px;
  color: #aab8cc;
  line-height: 1.8;
}
.canvas-card {
  overflow: auto;
}
.selection-surface {
  position: relative;
  touch-action: none;
  user-select: none;
  margin-top: 14px;
  cursor: crosshair;
}
.selection-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #f5dc82;
  background: rgba(245, 220, 130, 0.1);
  pointer-events: none;
}
.tools {
  margin: 12px 0;
}
.canvas {
  background: repeating-conic-gradient(#203044 0% 25%, #172638 0% 50%) 50% /
    16px 16px;
}
.status {
  line-height: 1.6;
  color: #a1e3c6;
  overflow-wrap: anywhere;
}
.error {
  color: #ffc0ad;
  border-color: #9b5348;
}
.warning {
  font-size: 12px;
  line-height: 1.6;
  color: #efc58d;
  margin-top: 8px;
}
.foot {
  padding: 12px 2px 30px;
}
</style>
