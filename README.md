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

当前采用单渲染进程、**128×48 Tile** 分块、每 **32 行**一个稀疏 RLE 检查点；npm 命令将 V8 old-space 限为 **48 MiB**。最新内存修正候选将 direct 帧、活动引用与扩展 key 限为 **4 MiB**，仅在 direct 启用时将 generic 帧缓存及活动引用限为 **2 MiB**；两条路径的详细像素借用同一个 **6 MiB** 缓冲，只在首次需要时分配一次。成功的 generic 输出在下一次 draw 前仍可读取；失败时立即归还本次 view 的借用。世界准备录制与 direct 关闭的路径保持原 **8 MiB** generic 限额。**这些新限额尚待完整性能验收**，局部预算不等于整个进程 RSS。1 px/Tile 使用精确整数像素合成，并对复杂几何保留 Canvas 路径；2/4/8 px/Tile 保留原有完整合成后面积缩小的画质路径。模块加载会核对源码及二进制 SHA-256，缺失、过期或不兼容时自动退回 Canvas／JavaScript。全景保持现有 **fullbright 静态纹理渲染**范围，实时光照、动态实体和运行时效果仍受限制；适合全世界概览与结构检查。

**前一轮 [PR #2](https://github.com/Live-yum/exploreTV/pull/2) 的已有远端结果**为 **125.064 秒 / 291.48 MB 保守总峰值**，同机原版为 **240.309 秒 / 297.81 MB**，耗时下降 **47.96%**。这些原生合成、raw 帧与低内存收益归于该 PR；见[远端同机对照](https://github.com/Live-yum/exploreTV/actions/runs/37408281055)和[固定证据](docs/benchmarks/overview-native-20261006-final.json)。历史远端 **257.554 秒 / 302.17 MB** 则来自 [run 37395562331](https://github.com/Live-yum/exploreTV/actions/runs/37395562331)。

**[草稿 PR #3](https://github.com/Live-yum/exploreTV/pull/3) 已验收阶段 `e2ca3ae` 的远端首次渲染为 108.085 秒 / 308.58 MB**；同机已有原生基线为 **125.218 秒 / 295.27 MB**，快 **13.68%**、保守峰值增加 **13.31 MB**。**该版本在远端尚未通过 60 秒与 300 MB 两个优先目标。** 完整 20,160,000 个像素、13 个独立窗口、384 张纹理和逻辑命令计数通过对照，见[本轮远端运行](https://github.com/Live-yum/exploreTV/actions/runs/37420185630)。后续共享详细缓冲和收紧缓存的内存修正候选尚待验收。

同一已验收源码的本地首次渲染为 **81.100 秒 / 273.22 MB**，本机原生基线 **97.588 秒 / 251.95 MB**，耗时减少 **16.90%**、保守峰值增加 **21.27 MB**。本地内存目标通过，不能替代远端结果或跨机器计算加速比。[本地证据](docs/benchmarks/overview-60s-local-20261006.json)和[详细说明](docs/overview-60s.md)记录两遍覆盖证明、通用 raw 矩形、精确标准坡块、结果复用及有界 CLOCK 缓存。

固定世界与固定范围可以提前建立**混合命令与精确残余单元缓存**，三个本地完整进程的成本分别为：

| 操作 | 完整进程耗时 | 保守总峰值 |
| --- | ---: | ---: |
| 普通首次整图 | 81.100 秒 | 273.22 MB |
| 世界预处理，已包含第一张 `preview.png` | 113.471 秒 | 262.81 MB |
| 已准备世界的缓存回放 | 14.085 秒 | 145.43 MB |

有效缓存三文件合计 **61.30 MB**，其中包含命令和 **5,590,895 个已经求得的输出残余单元**。回放复用这些结果，并没有把所有格从头重新光栅化；**14.085 秒也不包含前面的 113.471 秒世界准备成本**。准备后再额外回放一次，两个生成进程共 127.556 秒。如果只是反复获取不变图片，直接保存并复用生成的 PNG/WebP 即可。

远端同源码的世界准备为 **141.547 秒 / 293.11 MB**，已准备世界回放为 **14.667 秒 / 170.21 MB**，均通过全像素及 13 个窗口核验。远端这次低于 60 秒的是固定世界、固定范围的缓存回放；首次准备成本仍须单列。

性能工作流将分别提供约 **21 MB** 的证据与图像 artifact，以及约 **61.3 MB** 的可回放包 artifact。后者包含 `manifest.json`、`frames.bin`、`commands.bin` 与 `preparation.json`，保留 **7 天**；无需附带 `preview.png` 即可回放，但仍须提供与包绑定的相同世界、纹理和渲染源码。artifact 体积以该次上传实际结果为准。

```sh
# 可选：为固定世界准备命令包，同时生成 example-world-tape/preview.png
npm run prepare:world -- fixtures/example-world.wld example/assets artifacts/example-world-tape
# 输入和源码保持匹配时，再执行一次命令回放；不是首次世界渲染时间
npm run export:prepared -- fixtures/example-world.wld example/assets artifacts/example-world-tape artifacts/world-replayed.png
# 原 PNG 导出进程退出后，在独立进程中生成分享图
npm run encode:overview -- artifacts/world-overview.png artifacts/world-share.webp
```

默认分享图为 **4200×1200、quality 85 的有损 WebP**。本轮已有 PNG 的独立后处理实测为 **1,503,034 字节（约 1.50 MB）、1.523 秒、263.67 MB 保守峰值**；可[查看分享图示例](docs/benchmarks/large-world-share.webp)，保留约 17 MB 的原 PNG 作为静态像素参考。渲染与后处理顺序运行时耗时相加、峰值取较大者。世界命令包的失效规则、首次准备成本和分享图尺寸限制见[新文档](docs/overview-60s.md)。

已验收源码 `e2ca3ae` 的[远端完整平台验证](https://github.com/Live-yum/exploreTV/actions/runs/37420185717)已通过：JavaScript 741 项中 738 通过、0 失败、3 项可选测试跳过；Rust 4 项、Playwright 22 项及 WASM/H5/微信等检查通过。后续内存修正候选的最终时间、峰值及全图验证结果待补，不能沿用该阶段成绩。

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
