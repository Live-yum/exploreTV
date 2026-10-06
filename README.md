# exploreTV · 建筑片段实验室

独立的 Vue3 / uni-app 功能探索：导入 `.wld` → 选择矩形 → 使用真实 PNG Tile/Wall 贴图预览 → 保存并重读验证 Tile 片段。

**当前是部分静态近似渲染，绝非完整 Terraria 游戏窗口等价截图。** 预览不会拿地图色块冒充真实纹理；缺失贴图和未实现对象会明确报告。示例地图由用户授权公开；仅附带本查看工具实际必要的384张纹理，权利仍属Re-Logic，参见example/assets/NOTICE.md。私有源代码和游戏程序不分发。

## 全地图细节查看与导出

```sh
npm ci --ignore-scripts
npm run dev:viewer
```

打开 `http://127.0.0.1:4174/`，加载项目示例。查看器按视口读取 Tile，默认每格16像素，支持拖动、缩放和坐标跳转；逻辑全图134400×38400像素，Canvas与贴图缓存保持有界。缺失/未实现内容单独标记，不视为空白完成。

- [完整细节查看器](docs/world-viewer.md)
- [示例资源与集成步骤](docs/example-setup.md)
- [原分辨率整图导出](docs/full-resolution-export.md)
- [分块缩小全景工具](docs/full-world.md)
- [前一轮 PR #2 原生整图概览：架构与远端验收](docs/overview-native.md)
- [本分支大世界优化：首次渲染、世界命令回放与小体积分享图](docs/overview-60s.md)

```sh
npm run export:full -- fixtures/example-world.wld example/assets artifacts/full-resolution.png --tiles artifacts/full-resolution-tiles
```

直接从世界文件和真实纹理生成缩小版全景，无需先生成完整大 PNG 或分块包：

```sh
npm ci --ignore-scripts
npm run prepare:overview
MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 npm run export:overview -- fixtures/example-world.wld example/assets artifacts/world-overview.png
```

大世界默认输出完整范围的 **8400×2400 PNG（每 Tile 1 px）**；项目示例的既有精确输出约 **17 MB**，其他世界以实际压缩结果为准。`prepare:overview` 只提前编译与世界无关的原生合成及缩小模块，不读取世界或纹理；世界加载、索引、完整瀑布登记、PNG 解码、冷缓存建立、合成与最终 PNG 写入仍计入整图耗时。

当前采用单渲染进程、**128×48 Tile** 分块、每 **32 行**一个稀疏 RLE 检查点；npm 命令将 V8 old-space 限为 **48 MiB**。原 generic 原生帧缓存的保留与活动引用合并上限为 **8 MiB**；本分支 direct 帧及其活动引用、扩展 key 另有 **4 MiB** 上限，局部预算不等于整个进程 RSS。1 px/Tile 使用精确整数像素合成，并对复杂几何保留 Canvas 路径；2/4/8 px/Tile 保留原有完整合成后面积缩小的画质路径。模块加载会核对源码及二进制 SHA-256，缺失、过期或不兼容时自动退回 Canvas／JavaScript。全景保持现有 **fullbright 静态纹理渲染**范围，实时光照、动态实体和运行时效果仍受限制；适合全世界概览与结构检查。

**前一轮 [PR #2](https://github.com/Live-yum/exploreTV/pull/2) 的已有远端结果**为 **125.064 秒 / 291.48 MB 保守总峰值**，同机原版为 **240.309 秒 / 297.81 MB**，耗时下降 **47.96%**。这些原生合成、raw 帧与低内存收益归于该 PR；见[远端同机对照](https://github.com/Live-yum/exploreTV/actions/runs/37408281055)和[固定证据](docs/benchmarks/overview-native-20261006-final.json)。历史远端 **257.554 秒 / 302.17 MB** 则来自 [run 37395562331](https://github.com/Live-yum/exploreTV/actions/runs/37395562331)。

**本分支已验收阶段的本地首次渲染为 86.673 秒 / 273.76 MB**，在同一环境的已有原生基线 **97.588 秒 / 251.95 MB** 上，耗时再减少 **11.18%**，保守峰值增加 **21.81 MB**。完整 20,160,000 个像素、13 个独立窗口、384 张纹理和逻辑命令计数通过对照。**该阶段 300 MB 内存目标通过；首次世界仍未达到 60 秒。** 后续减少重复归约、调整缓存淘汰的最终候选尚待完整复测。上述是本地 Node 24.19.0 的结果，新分支尚未做对应的远端同机复测，不能与前一轮远端时间直接计算加速比。[详细使用与验收说明](docs/overview-60s.md)记录两遍不透明覆盖证明、通用 raw 矩形、精确标准坡块，以及成功与未通过产物验收的诊断运行的区别。

本分支另提供固定世界的预处理/回放，以及 PNG 完成后的 WebP 分享图。它们分别计时；完整世界命令包的首次准备和回放性能仍待实测：

```sh
# 可选：为固定世界准备命令包，同时生成 example-world-tape/preview.png
npm run prepare:world -- fixtures/example-world.wld example/assets artifacts/example-world-tape
# 输入和源码保持匹配时，再执行一次命令回放；不是首次世界渲染时间
npm run export:prepared -- fixtures/example-world.wld example/assets artifacts/example-world-tape artifacts/world-replayed.png
# 原 PNG 导出进程退出后，在独立进程中生成分享图
npm run encode:overview -- artifacts/world-overview.png artifacts/world-share.webp
```

默认分享图为 **4200×1200、quality 85 的有损 WebP**。本轮已有 PNG 的独立后处理实测为 **1,503,034 字节（约 1.50 MB）、1.523 秒、263.67 MB 保守峰值**；保留原 PNG 作为静态像素的精确参考。渲染与后处理顺序运行时耗时相加、峰值取较大者。世界命令包的失效规则、首次准备成本和分享图尺寸限制见[新文档](docs/overview-60s.md)。

原分辨率导出采用流式PNG，不创建整张巨型Canvas。超大PNG不保证普通浏览器可打开，兼容分块输出可按清单重建完整细节。命令选项与实际内存/文件限制以导出文档为准。普通缩小全景只作overview，不等同于原分辨率全图。

## Run

```sh
npm ci --ignore-scripts
npm test
CI=1 npm run build:h5
CI=1 npm run build:mp-weixin
node scripts/check-mp.mjs
npm run dev:h5
```

从合法来源导入 `Tiles_N.png`、`Wall_N.png` 和 `water_N.png`。输入矩形坐标与宽高或在当前场景上拖选矩形，再生成预览。提供缩放与方向平移；保存 `.tvtiles.json` 可重新导入并独立裁剪，无需重新打开原始世界。原始世界只读，不自动联网上传文件。

## Verification

GitHub Actions runs bounded parser/fragment tests, sprite command tests, a20.16M-cell synthetic performance case, H5 and Weixin builds, platform leakage checks, and a Chromium UI flow. Public CI uses original synthetic fixtures plus the explicitly shared example world and necessary asset manifest checks. It does not silently skip a requested real-world test or claim its synthetic test world is game-loadable.

For a user-supplied real map and textures:

```sh
npm run test:real -- /path/world.wld expected-sha256
node scripts/render-world.mjs /path/world.wld /path/Images 4180 631 48 32
```

Local reports and export files go to ignored `artifacts/`. Only the designated example world and necessary texture subset are authorized for distribution. Other worlds/resources remain private. The three separately approved overview images are on the `previews/static-world-20261005` branch.

第二轮起增加：染色开关、PNG 通道契约、整场景黑底预乘合成、液体前/后景与固定帧控制。TConvert 原始通道使用有界 RGBA8 非交错 PNG 解码；不支持的格式明确跳过，不回退到失真读回。标准透明 PNG 模式保持 Canvas 兼容。液体与瀑布采用后续实现的静态几何和冻结帧；具体支持范围及未实现邻域以各功能文档和导出报告为准。亮度仍为 fullbright 贴图检查，不是存档恢复实时光照。

- [Paint/channel scope](docs/paint-scope.md)
- [Liquid and lighting scope](docs/liquid-lighting-scope.md)
- [Rendering scope](docs/rendering-scope.md)
- [Data contract and mini-program integration](docs/integration.md)

The fragment retains all serialized Tile fields, including flags/frames/coatings. It excludes non-Tile sections: chest contents, signs, tile entities, NPCs. Multi-cell objects crossing the selection are truncated. Restore validation is into an independent Tile grid, not a game-loadable `.wld` writer.

No deployment, GitHub Pages, app-store publication, signing, or credential changes are included.

## Rust → WebAssembly decoder

The original Rust core accelerates WLD validation, column indexing and region extraction;
it preserves the existing JS Tile/fragment contract and has a 128 MiB linear-memory cap.
The 28,904-byte compiled module and pinned reproducible build are included.
H5 and the standalone viewer select WASM when available, with explicit JavaScript
fallback; the WeChat build currently retains JavaScript. This does not accelerate
Canvas drawing or PNG compression. The independent Chromium CI measured real-world
opening at 477.9 ms JS versus 73.3 ms WASM, while one small region had no gain.
See [ABI, browser boundaries and complete benchmarks](docs/wasm-core.md).

## Coverage checkpoint

The actual 8400×2400 example's complete planner audit now accounts for every
visible active Tile: 11,068,783 planned cells and 15,485 source-defined emitters
with no static Tile body. Unsupported Tile cells, missing PNGs and invalid
source crops are all zero for this fixture; all 384 required PNGs are checked.
The explicitly configured whole-world static registry also leaves zero known
liquid omission events in this fixture. It registers all 1,969 origins with an
explicit 100,000-origin cap; the interactive viewport retains the source default
cap of 1,000. This is not full game-equivalence: terrain/wall merging, frozen
variation/time, fullbright lighting and omitted runtime effects retain the
documented approximations. Future unsupported contexts remain reported.
A scene is capped at 131,072 commands; overly complex selections fail clearly
and can be reduced. Full-world export uses bounded chunks. Special-object
selection contexts preserve owner order and include intersecting overhangs
without adding neighboring Tile records to the saved fragment.
