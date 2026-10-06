# 预编译普通 Tile / Wall 帧与 WASM 直接命令流

本轮固定基线为已合入 PR #6 的主分支 **`fae6f52a5227cef3f6544f383d074f10da84e1e0`**。新增两项可以分别关闭的优化：与具体世界无关的分页帧包，以及 WASM 从有界 Tile 区域直接生成普通帧记录的路径。具体性能以本 PR 对应提交的 Actions 完整对照为准；不沿用 PR #6 对 `cbdf5b3` 的加速成绩，也不把世界准备包的回放计作新世界导出。

## 使用

```sh
npm ci --ignore-scripts
npm run prepare:overview
npm run prepare:overview-frames -- example/assets example/assets/overview-frame-pack
MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 npm run export:overview -- \
  fixtures/example-world.wld example/assets artifacts/world-overview.png
```

导出器默认检查纹理目录中的 `overview-frame-pack`。未安装包时继续使用动态帧准备；默认包损坏或过期会在统计中记录原因并回退。需要把包放在其他目录时，显式设置 `EXPLORETV_FRAME_PACK_DIR`；显式指定却无法使用的包会报错，避免一次意图测试预编译的运行悄悄测成动态准备。构建器拒绝覆盖已有输出目录，纹理、准备规则或平台改变后，生成新的目录再选择它。

编译器只接收纹理目录和输出目录，没有世界文件参数。它使用现有的精确 raw / slope 准备器，预计算常用帧的 base、additive、透明度、规范裁剪和不透明均值。编译过程的函数时间、进程存续时间和 OS 峰值单独写入 `build-report.json`。新世界计时包含加载 WASM、打包 Tile、加载帧索引、校验实际源 PNG 身份、读取并验证页面、动态回退、合成与写 PNG。

## 帧的范围与身份

[`core/overview-frame-recipes.mjs`](../core/overview-frame-recipes.mjs) 统一定义稳定数字 recipe ID 和几何。普通 Tile 包含 16 种邻域变体，以及完整块、半砖、四种规范坡块；Wall 包含 20 种坐标/邻域变体。paint 0 与 31 按现有身份染色合同共享像素。当前普通块 allowlist 为 110 个类型，构建时只编译纹理目录实际提供的合法源；示例资源中可编译的普通 Tile / Wall 图集共有 147 张。

未提供的纹理不会被补成虚构的帧。其他染色、保存帧、复杂液体、特殊树木/家具、任意裁剪、翻转或 shader 变体继续使用已有规划和准备路径，保留原来的诊断。不能通过 `type` 独自决定帧；邻域、shape、paint 语义和源裁剪都是身份的一部分。墙体仍为 32×32，目标相对 owner 偏移 −8 px，覆盖分析保留它可能触及 3×3 Tile 的几何。

输出包包含：

| 文件                | 内容                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `manifest.json`     | 格式/recipe/字节合同、准备规则和依赖哈希、平台与 baker 身份、源纹理哈希、索引及每页哈希 |
| `index.bin`         | 每个 recipe 32 B，记录源、页、base/additive 偏移、尺寸、flags、均值                     |
| `page-NNNNN.bin`    | 默认每页最多 64 KiB，完全相同的帧像素去重，最后一页按实际用量存储                       |
| `build-report.json` | 编译成本、逻辑帧与去重帧数、像素/索引/磁盘字节以及完整输入身份                          |

运行时只在实际源 PNG 快照的 SHA 与大小匹配包中记录后跳过 atlas 解码。索引、页和 shader 合同仍需校验；发生源变化时保留原解码器和诊断路径。包绑定准备代码、`package-lock.json` 和像素 baker 平台，跨平台不能直接假定字节合同一致。修改 Rust 的帧选择逻辑时，WASM 构建身份和差分测试另行验证它与 recipe 表一致。

## 普通命令由 WASM 直接输出

[`planOverviewBand()`](../core/renderer.mjs) 把当前有 halo 的有界 Tile 区域打包到 WASM。Rust 计算普通块/墙的邻域、变体和裁剪条件，输出唯一 recipe 表和 stride 为 5 的 `Int32` 记录 `[frameSlot, dx, dy, x, y]`。JavaScript 只遍历 Rust 返回的特殊/不支持 owner 索引，继续运行原有特殊对象规则。它不会先执行完整 `planScene()` 创建普通对象，再将对象复制成数值数组。

WASM 最后把普通记录与特殊对象事件按既有墙体、非固体、瀑布、固体及特殊层顺序合并。结果为：

- `plan.commandStream.tokens`：`Int32Array`，负值为 `-recordIndex - 1`，非负值索引特殊对象表。
- `plan.commandStream.objects`：仅特殊对象。
- `plan.compactTerrain.records`：普通记录；`recipeIds` 为唯一数字帧编号；`frames` 为对应的冻结模板。

记录、recipe ID 和 token 从 WASM 整段复制到一个自有 `ArrayBuffer`。资源加载发生 `await` 或下一块复用 WASM 内存时，已有计划仍然有效。没有逐普通命令的 JS Map 插入和记录写入；唯一帧模板按当前区域生成，不含像素强引用。

direct 的第一遍覆盖分析、第二遍帧 slot 定位和原生批次编译直接读取数值流。只有确需通用绘制回退的命令才物化为对象。当前覆盖分析和批次调度仍有 JavaScript，像素合成/缩小继续使用已经核验的 C 模块；本轮迁移的是普通帧选择及命令生成，不能称为整个渲染器已迁移至 WASM。

## 内存与退化路径

帧包读取器本身不缓存像素页。direct 是唯一页持有者，整页 backing、动态 fallback 帧、均值 metadata、扩展 key 和活动批次 pin 共用原 **4 MiB** 上限。多个帧引用同一页时只计一次页面字节；最后一个引用淘汰后才释放页面。过大页、失效 slot、受 pin 保护的帧和有界 flush 都有针对性测试。`packPageBytes` 是 `liveFrameBytes` 的子集，不能额外相加。

帧索引及其有界查找 metadata 不属于像素页预算。`indexBytes` 只记录二进制索引的 backing，未包含索引 Map 和 descriptor 的 JavaScript 堆开销；这些仍计入完整进程 RSS。

原有 **6 MiB** 详细 RGBA arena 继续由 direct/generic 共用。新的 WASM 24 MiB 工作区上限针对最坏允许区域，以真实 Rust `Vec` 容量计量；它不是每块固定分配量，也不是整进程 RSS 上限。默认仍为 128×48 核心、各边 10 Tile halo，没有整世界展开，也没有新增滚动条带缓存。

`peakCompactTerrainBytes`、`peakCommandStreamBytes` 和 `terrainWasm.peakStreamOutputBytes` 当前都会涉及相同的输出 backing；它们用于不同调用层的观测，不能相加成三份内存。新路径减少普通对象分配，但没有修改 GC 参数、加线程或扩大既有帧缓存预算。

## 独立消融与验收

```sh
# 同一源码、同一 Node 和原生模块，分别启动完整新进程
EXPLORETV_FRAME_PACK_DIR=artifacts/overview-frame-pack \
  node scripts/run-overview-ci.mjs artifacts/precompiled-default
EXPLORETV_FRAME_PACK_DIR=artifacts/overview-frame-pack EXPLORETV_DISABLE_FRAME_PACK=1 \
  node scripts/run-overview-ci.mjs artifacts/dynamic-frames
EXPLORETV_FRAME_PACK_DIR=artifacts/overview-frame-pack EXPLORETV_DISABLE_WASM_FRAME_STREAM=1 \
  node scripts/run-overview-ci.mjs artifacts/legacy-frame-planning
```

第二项仅关闭帧包，仍由 WASM 输出普通命令；第三项仅恢复旧 compact writer，仍使用预编译帧。原有邻域/液体 WASM 在三项中都启用。`EXPLORETV_DISABLE_TERRAIN_WASM=1` 可以关闭全部 terrain WASM；它不是上述仅命令流消融的替代。实验性 resolved-cell mask 在本轮所有对照中关闭。

带 `[export-overview]` 标记的 PR 使用[整图 workflow](../.github/workflows/export-overview.yml) 在同一 runner 顺序执行固定 `fae6f52`、默认候选、动态帧候选、旧命令规划候选。每项比较 8400×2400 全部 RGBA、13 个独立原路径区域、384 个源纹理、完整范围、owner/逻辑计数和遗漏诊断；同时绑定真实被测 Git commit、源码、原生/WASM 二进制，以及帧包来源/索引/页面哈希。编译报告与被实际执行的 manifest、规则及纹理必须一致。

60 秒和 **300,000,000 B** 是分别计算的严格目标。CI 的 600 秒/500 MB 保护预算仅防止失控，不代表性能目标达标。每模式一次运行仍有 runner 噪声、文件缓存和顺序影响，阶段计时也有包含关系；由同一次完整运行的真实差值判断改动，不由命中率或局部测试外推成绩。

相关测试：[帧包逐字节准备](../test/overview-frame-pack.test.mjs)、[WASM 帧流差分](../test/overview-frame-stream.test.mjs)、[真实引擎等价](../test/compact-terrain-engine.test.mjs)、[页/slot/批次预算](../test/direct-terrain-overview.test.mjs)、[消融证据检查](../test/frame-pack-comparison.test.mjs)。完整平台构建由[验证 workflow](../.github/workflows/validation.yml)执行。
