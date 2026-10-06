# 普通地形紧凑规划、WASM 邻域批处理与原生覆盖跳过

本文保留 [PR #6](https://github.com/Live-yum/exploreTV/pull/6) 的实现与验收合同。该 PR 已合入 `fae6f52`；后续的资源帧包、WASM 直接命令流及当前对照方法见[预编译帧与 WASM 流](overview-frame-pack.md)。下文的 `plan.commands` 混合数组是该历史阶段的数据布局，新路径使用独立的 `Int32Array` 与特殊对象表。

本轮以主分支提交 **`cbdf5b3c3b9f4952a2075a133f809b9b2d779d12`** 为固定基线，针对新世界第一次 1 px/Tile 整图导出中的对象分配、重复帧解析和无用像素合成进行修改。普通 Tile / Wall 现在直接生成紧凑记录，邻域帧计算可以批量交给 WASM，direct 按唯一帧验证并通过代际 slot 复用像素缓存，原生合成器可以跳过已解决的目标片段。

**最终性能与平台状态见本 PR 对应的 Actions 运行和 PR 描述；本文记录实现与验收合同，不内嵌未验收成绩。** 实现完成或测试通过本身不表示首次整图达到 60 秒或保守总峰值低于 300 MB。本地功能测试、试运行和历史远端成绩各自保留其环境与源码身份，不用本地 smoke 耗时与历史远端耗时计算加速比。该轮优化也不使用已准备世界的回放时间代替首次生成时间。

## 1. 普通命令在生成时就进入紧凑缓冲

此前 direct 的输入仍是 `planScene()` 创建的完整命令对象列表。即使一个普通块最终完全由 direct 处理，其对象和坡块多边形也已经分配，之后还需要重新解释源帧身份。

新增的内部入口 [`planOverviewBand()`](../core/renderer.mjs) 与公开规划器复用原有遍历及规则，但在普通墙体和无保存帧普通方块的生成分支，直接写入 [`overview-command-buffer.mjs`](../core/overview-command-buffer.mjs)。它没有先调用 `planScene()` 再转换对象数组。

命令流仍保存在 `plan.commands` 中：特殊命令为原对象，普通命令为负整数 `token = -recordIndex - 1`。`plan.compactTerrain` 包含：

| 字段      | 内容与用途                                                                     |
| --------- | ------------------------------------------------------------------------------ |
| `records` | 有界 `Int32Array`，每条记录为 `[frameSlot, dx, dy, x, y]`，共 20 B             |
| `stride`  | 固定为 5，明确记录边界                                                         |
| `frames`  | 冻结的唯一帧模板数组，保存源资源、裁剪、尺寸、类型、染色、fidelity 和必要 clip |

`dx / dy` 是相对当前读取场景的目标像素坐标，`x / y` 是相对场景的 owner Tile 坐标。模板不包含这四个坐标，也不包含已解码或已准备的像素。相同源帧的命令共享模板；规范坡块共享冻结 clip；半砖保留原来的 8 px 高度和目标偏移。未满足紧凑编码条件的非规范 ID、paint 或 shape 继续使用原对象路径。

`getOverviewCommandTemplate()` 供只需要源帧字段的消费者读取。`materializeOverviewCommand()` 只在通用回退需要完整命令时创建对象，并为 clip 重新创建独立可变数组。direct 消费模板和数值记录，不为普通命令逐条物化。

### 层序、owner 与诊断

负 token 位于原命令应出现的位置。墙体、背景液体及 `drawBeforeTiles` 命令、各 Tile 组、瀑布和前景液体的原有关系继续生效；特殊对象不会统一挪到最后绘制。存在 selection context 时，混合 token / 对象流按原 owner 顺序排序。存在瀑布 registry 时，普通帧的固体／非固体分类按唯一模板完成，命令仍按原分组与遍历顺序进入对应层。

输出范围、emission core、邻域 halo、完整资源依赖、支持／遗漏诊断和逻辑命令预算沿用原合同。裁剪只消除可证明不影响输出的生成工作，不能抹掉资源或 owner 诊断。公开 `planScene()` 的默认返回形式保持全对象，默认不增加计时字段，也保持每条坡块 clip 的独立可变性；它继续作为参考路径。

## 2. WASM 批量计算普通邻域，已有原生合成继续使用

[`core/overview-wasm.mjs`](../core/overview-wasm.mjs) 在一个 renderer 内复用一个无外部 imports 的 WASM 实例。JavaScript 将每格的类型、墙体 ID、active 和可见性标志打包为两个 `Uint32`；[`wasm-core/src/overview.rs`](../wasm-core/src/overview.rs) 批量输出每格两个 `Uint8`：

- wall 邻域帧索引，包含依世界坐标变化的中心变体，范围 0–19。
- 普通 Tile 的同类型邻域 mask，范围 0–15。

单独地形输入为 **8 B/cell**，输出为 **2 B/cell**，合计 **10 B/cell 的输入／输出工作数据**。启用整图液体规划时，另用每格 4 B 的液体／形状／材质标志和最多 4 B 的候选记录，联合上限为 **18 B/cell**。例如一个 148×68 读取区域需要最多 181,152 B；允许的最大 65,536 格区域需要最多 1,179,648 B。这不是完整 WASM 线性内存或总 RSS：模块及分配器开销、原有 region 数据、紧凑命令缓冲和纹理缓存另行存在。报告分别记录 `peakWorkingBytes` 和 `peakLinearMemoryBytes`，不能只用前者证明内存目标。

WASM 保留区域边缘、不可见墙／块、隐藏墙 318、同类型比较和有符号世界坐标的原规则。返回的帧表由 `planOverviewBand()` 同步消费，不保存到最终 plan 中。无法无损打包的输入退回 JavaScript 邻域计算；公开 `planScene()` 始终自行计算参考帧。

ABI 2 还批量筛选液体候选和验证普通液体的 3×3 邻域。无关干格不进入 JavaScript 液体遍历；已证明的普通湿格直接使用数值邻域分类，已证明遮挡的湿固体保留计数并跳过绘制。坡块、半砖、特殊对象、混合液体、Shimmer、无效字段和缺失邻格都回到完整参考规则，存在 selection context 时保留原液体扫描。候选仍按原列优先顺序消费，普通液体命令的 atlas、动画帧、透明度、owner、诊断和层序不变。`liquidRegions / liquidCandidateCells / liquidFastCells` 记录实际执行范围。

[`scripts/overview-terrain-wasm.mjs`](../scripts/overview-terrain-wasm.mjs) 校验 WASM 二进制与 Rust 源码哈希、ABI 和 imports。缺失、过期或不兼容时明确报告原因并退回 JavaScript 邻域路径。WASM 模块加载、编译、实例创建及运行期打包都发生在被测 exporter 进程中。

本轮没有把整个渲染器改写为 WASM。特殊对象规则、复杂液体几何与普通液体命令组装、资源加载和流程组织仍有 JavaScript 工作；已经完成字节精度验证的 C 原生合成和缩小继续使用，目标片段 mask 作为显式实验保留。`prepare:overview` 提前构建世界无关的原生模块；修改 Rust 后通过 `sh wasm-core/build.sh` 重建并校验仓库内的 WASM 产物。不能把世界相关准备移出首次导出计时来制造加速成绩。

## 3. 唯一帧验证与有界代际 slot

[`direct-terrain-overview.mjs`](../scripts/direct-terrain-overview.mjs) 第一遍扫描只在首次遇到一个紧凑帧模板时解析和验证其源帧。后续命令复用数值验证标志和不透明均值。第二遍优先通过 `slot + generation` 定位像素缓存，避免对每条命令重新构建 key、查找 namespace 并访问 Map。

每个 view 的唯一模板只保存验证标志、均值、slot 和代际数值，共 13 B/模板。它不保存 frame 对象引用。缓存淘汰同时删除 Map 和 slot 表中的像素引用；slot 复用时递增代际，旧 view 引用必须在代际匹配后才能命中，否则重新加载。当前原生批次使用中的 frame 保持 pinned，空间不足时有界 flush，然后继续淘汰。

现有 **4 MiB direct 联合预算**仍约束缓存的 base / additive 像素、可选不透明均值和计入的扩展字符串 key；活动批次引用与缓存共享这一个预算。不会因另存逐命令 frame 引用而把已淘汰像素留在预算外。此预算不代表所有 JavaScript 元数据或总进程 RSS。详细 RGBA 仍由 direct 与 generic 共用原有 6 MiB arena。

新增计数包括 `compactFramesValidated`、`compactValidationReuses`、`frameKeyLookups`、`compactSecondPassSlotHits`、`compactSecondPassReloads` 和 `peakCompactSlotBytes`。这些指标用于确认重复工作是否减少；缓存命中率本身不能替代完整运行耗时。

## 4. 在原生合成器内跳过已解决片段

**目标片段 mask 默认关闭，显式设置 `EXPLORETV_ENABLE_RESOLVED_CELL_MASK=1` 才开启。** 第一轮完整同机实验中，减少像素工作量没有换来完整耗时下降，因此没有把它作为默认加速。实验路径仍保留精确计数、字节验证和同提交的完整对照；已有整条命令剔除、直接均值和覆盖判定继续默认生效。

第一遍覆盖分析确定哪些 16×16 目标格可以直接使用最终不透明均值，哪些格需要通用路径，哪些格仍需详细合成。传给 [`native-blitter.c`](../scripts/native-blitter.c) 的 mask 使用 0 表示需要详细合成、1 表示已经有精确结果、2 表示 direct 输出不会被采用的区域。

`composeIntoMasked()` 在 C 内按照目标格边界处理片段。**32×32 墙体相对 owner 偏移 −8 px，可能触及 3×3 格。** 合成器同时处理负目标偏移、输出边缘的部分格、UV 翻转和 base / additive 两种平面，不在 JavaScript 中把墙体拆成一批额外命令。

每个 descriptor 的全部有效片段处理完后才进入下一个 descriptor，原透明绘制顺序保持不变。mask、源帧和描述符在写入目标前完成验证，禁止会影响结果的目标内存别名；JavaScript fallback 保留同一合同。

`blitPixelsToResolvedCells` 统计实际提交平面中因 mask=1 被跳过的像素工作；`maskedBlitPixelsSkipped` 包含已解决和 direct 不使用的片段，`maskedUnsafeBlitPixelsSkipped` 单列后者。整条命令在提交前被跳过的工作另有计数。base 与 additive 分别计数，因此这些是像素合成工作量，不能解释为世界中互不重复的像素数。

## 5. 阶段计时存在包含关系

[`world-render-engine.mjs`](../scripts/world-render-engine.mjs) 汇总新的 `plannerPhaseMilliseconds`，[`compare-overview-benchmarks.mjs`](../scripts/compare-overview-benchmarks.mjs) 保留原始阶段及计数并明确包含关系：

| 指标                               | 解释                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `stageMilliseconds.plan`           | 外层规划时间，包含运行期 WASM 打包、邻域计算和内部规划器等工作       |
| `plannerPhaseMilliseconds.total`   | 内部规划器时间，包含 `walls / liquids / tiles / layers` 及初始化开销 |
| `wasmPacking / wasmPlanning`       | 属于外层 plan；位于内部规划器调用之前，不应再与外层 plan 相加        |
| direct `scanAndBatch`              | 包含第一遍 `scan` 和第二遍 `batch`                                   |
| direct `prepare / clear / compose` | 嵌套在扫描或批次工作中，不能再加到 `scanAndBatch` 上                 |
| direct `partition / reduce`        | 属于 direct 外层总耗时，按各自阶段比较                               |

规划子阶段只在阶段边界读取时钟，不在每个 Tile 上计时。`tiles` 目前同时包含普通块与各特殊 Tile 规则，不能把它全部归因于普通地形。显式 GC 计时只覆盖显式调用，自动 GC 的耗时可能已经包含在上述阶段中。

## 6. 可复现的消融入口

以下开关只改变候选源码的路径选择，不等同于检出固定旧基线。默认优化入口用于 1 px/Tile、raw 通道、非世界录制且 direct 条件满足的整图路径。

| 环境变量                                 | 效果                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `EXPLORETV_DISABLE_COMPACT_TERRAIN=1`    | 使用原对象规划入口；WASM 邻域随紧凑入口关闭，仍保留本轮 direct / mask 实现 |
| `EXPLORETV_DISABLE_TERRAIN_WASM=1`       | 保留紧凑规划和唯一帧路径，邻域帧由 JavaScript 计算                         |
| `EXPLORETV_ENABLE_RESOLVED_CELL_MASK=1`  | 显式开启实验性原生目标片段 mask；默认关闭，完整实测决定是否应启用          |
| `EXPLORETV_DISABLE_RESOLVED_CELL_MASK=1` | 强制关闭目标片段 mask，优先于 ENABLE 开关；已有整命令跳过及最终均值仍生效  |

Linux 上可使用完整进程 harness 为每次运行选择新的输出目录：

```sh
npm ci --ignore-scripts
npm run prepare:overview
node scripts/check-overview-native.mjs

node scripts/run-overview-ci.mjs artifacts/compact-default
EXPLORETV_DISABLE_TERRAIN_WASM=1 node scripts/run-overview-ci.mjs artifacts/compact-js-neighbours
EXPLORETV_DISABLE_COMPACT_TERRAIN=1 node scripts/run-overview-ci.mjs artifacts/compact-object-plan
EXPLORETV_ENABLE_RESOLVED_CELL_MASK=1 node scripts/run-overview-ci.mjs artifacts/compact-masked

# 每个输出都需要独立像素核验；按实际输出目录重复执行。
node scripts/verify-overview.mjs fixtures/example-world.wld example/assets artifacts/compact-default/world-1px.png --example
```

为单独观察紧凑表示的收益，应比较“禁用 WASM 的紧凑路径”和“对象规划路径”；默认与对象路径的差异同时包含 WASM。所有消融都需要检查报告中的实际启用状态、完整 RGBA、遗漏与资源身份，不能只看环境变量。保持同一机器、Node、依赖、堆／GC 参数和输出范围，顺序运行新的进程；操作系统文件缓存仍不是受控变量。

本轮 Actions 对固定基线和默认候选完成对照后，还会顺序运行同一候选提交的两组完整消融：**禁用 WASM 地形／液体批处理**、**显式启用原生目标片段 mask**。两组都独立验证完整像素和 13 个区域，用于确认 WASM 与 mask 对实际完整耗时和峰值的影响；减少查询或像素工作量不能直接证明墙钟时间下降。对象规划开关保留为额外手动实验入口。

## 7. 验收合同与报告位置

本地已完成紧凑／公开规划结果对照、全部 Tile 家族与 shape、特殊层、裁剪、owner、诊断、预算和可变 clip 合同检查；代际缓存、混合命令及原生 mask 有对应字节正确性测试。完整测试数量、平台结果和远端性能以最终提交的运行报告为准。

相关代码与测试：

- [紧凑规划等价测试](../test/compact-overview-planner.test.mjs)
- [真实 WASM 邻域测试](../test/overview-terrain-wasm.test.mjs)
- [整合 renderer 测试](../test/compact-terrain-engine.test.mjs)
- [direct 缓存／像素测试](../test/direct-terrain-overview.test.mjs)与[原生合成器测试](../test/native-blitter.test.mjs)
- [固定 main 整图对照 workflow](../.github/workflows/export-overview.yml)与[平台验证 workflow](../.github/workflows/validation.yml)

整图 workflow 固定旧提交 `cbdf5b3c3b9f4952a2075a133f809b9b2d779d12`，在同一个 runner / job 中依次运行基线、默认候选、候选 JavaScript 邻域消融、候选启用 mask 消融，共四次完整冷进程。每个 checkout 构建自身原生模块，以完整冷进程测量世界读取、索引、瀑布登记、纹理解码、规划、合成、缩小、GC、PNG 压缩及写入。验证源码报告与确切 Git 提交／tree 一致，且渲染依赖、世界与资源身份对应。

接受任何一组比较之前，参与比较的运行都必须覆盖完整 **8400×2400** 输出及 **20,160,000 个 Tile**，通过完整 RGBA 哈希、13 个独立区域、384 张纹理身份、逻辑命令计数和遗漏表核验。通过正确性及 600 秒／500 MB 防护门槛后，再分别报告 **60 秒时间目标**、**300 MB 保守总峰值目标**以及两项是否同时通过。绿色 workflow 本身不表示这两个优先目标已达到。MB 按十进制，MiB 按 1,048,576 B。

最终结果在[整图对照 Actions](https://github.com/Live-yum/exploreTV/actions/workflows/export-overview.yml)、[平台验证 Actions](https://github.com/Live-yum/exploreTV/actions/workflows/validation.yml)及本 PR 描述中报告。读取结果时应核对运行绑定的候选提交，PR 描述应给出对应 run 和完整证据链接；工作流列表中其他提交的结果不替代本轮结果。

| 最终验收项目           | 报告内容与判定                                                       |
| ---------------------- | -------------------------------------------------------------------- |
| 平台测试               | 最终候选提交、测试数量、跳过项目及 Actions run 链接                  |
| 固定 `cbdf5b3` 基线    | 同 runner 完整冷进程耗时与保守总峰值                                 |
| 默认候选               | 完整冷进程、保守总峰值、与同次基线的比较                             |
| 同候选 WASM／mask 消融 | 各自完整运行、像素核验及与默认候选的比较，不从操作量直接推导加速     |
| 正确性与身份           | 完整像素、13 区域、资源、确切源码及逻辑计数                          |
| 60 秒／300 MB 优先目标 | 分别报告时间、内存及同时通过的布尔值；不以 workflow 绿色替代目标判定 |

## 8. 后续优化仍需按新计时决定

本轮消除了普通命令前置对象和重复解释的一部分工作，尚未消除全部规划扫描。下一步先用新报告确认剩余热点：

1. **液体和特殊对象规划。** `liquids` 与 `tiles` 分阶段测量后，再对液体候选及复杂 Tile 家族取样定位。迁移到 WASM 时必须保留邻域规则、owner、遗漏和层序，不能为了少分支而改变画面合同。
2. **滚动邻域条带。** 当前仍按有界区域读取，邻近块会重复读取 halo。可研究保留条带并只更新新进入的数据；需要替换现有工作数据并继续保留 halo，而不是额外叠加一份展开世界。
3. **与世界无关的分页资源。** 常见精确帧、base / additive、规范坡块和均值可按纹理哈希、规则版本、通道及舍入合同预编译。罕见变体按需处理。它与现有保存世界命令和残余结果的准备包不同，仍需先测量帧准备时间和重建次数。
4. **剩余覆盖分析、批次编译和线程。** 若它们仍占主要时间，可继续在 WASM 或现有原生批处理内减少工作量，再评估共享只读资源的有界并行。当前没有以扩大缓存、取消 GC 或复制多个完整 renderer 作为默认加速方案。

任何后续成绩都应重新绑定确切源码和完整输出，继续与本轮固定主分支或之后明确的新基线比较。当前文档记录实现与验收方法，不把候选方案写成已实现的加速成绩。
