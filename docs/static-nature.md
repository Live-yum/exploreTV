# 静态蜘蛛网与藤蔓

`core/static-nature.mjs` 是原创的只读 sprite planner，提供蜘蛛网 51 和藤蔓 52、62、115、205、382、528、638 的静态贴图布局。它不使用替代颜色、占位图或游戏源码片段；贴图必须由宿主提供并进行尺寸、解码和来源校验。

这里的“支持”表示能规划真实贴图裁剪，不能等同于游戏截图一致性。随机外观变体固定为 0；藤蔓固定为零旋转、零风推的直立姿态；实时光照、自然光 shader、风摆、碰撞扰动均不实现。

## 接口与宿主接入

```js
import {
  planStaticNature,
  STATIC_NATURE_TYPES,
} from "./core/static-nature.mjs";

const result = planStaticNature(region, x, y, tile, { revealInvisible: false });
```

`x/y` 是选区局部格坐标，`region.rect.x/y` 是选区世界起点。`region.cells` 与现有核心一致，采用列优先。边缘格必须由 `region.context` 或包含 halo 的 region 提供真实邻居；不把缺上下文当空气。`region.source.width/height` 可提供真实世界边界。

- 非该模块的类型返回 `null`，供宿主继续其他路径。
- 支持时返回 `supported: true`，以及 `sx/sy/sw/sh`、`offsetX/offsetY`、`flipX`、`opacity`、`fidelity` 和 `reason: null`。
- 拒绝时返回 `supported: false` 和明确的 `reason`；包括缺 halo、世界边界、未知类型、异常形状、意外存储帧等。宿主应把原因写入覆盖报告。

宿主构造 `Tiles_<tile.type>.png` 命令，目标坐标为 `x*16+offsetX, y*16+offsetY`，大小 16×16。`flipX` 必须围绕该目标矩形执行，不能改变世界坐标或将负目标宽度当成 Canvas 翻转。对处理后的 base 与 additive 两层应用同一翻转与 opacity。资源不存在或裁剪超界仍由宿主拒绝，不能把计划成功计为已经画出。

此模块不修改 region、Tile 字段、原始字节或片段保存格式。它不自动导入纹理、不进行世界物理更新，也不通过破坏悬空藤蔓来“修复”地图。

## 蜘蛛网 51

连接条件是 active 且允许附着，不限于相同类型或 solid。当前固定事实表来自 Terraria 1.4.5.8 的 `tileNoAttach` 初始化，覆盖已知 ID 0–753；它包含 435–439 的循环赋值。范围外的 active 邻居明确拒绝。非显影模式下，隐形状态不同的邻居不连接；actuated 不等同于 inactive Tile，仍遵循原 framing 的 active 标志。

以 N/W/E/S 的位 1/2/4/8 选择 18 像素网格上的固定第 0 变体。仅当四方向都连接时，额外按优先顺序选择成对对角缺口：

1. NW 与 NE 都断开：源坐标 (108,18)
2. SW 与 SE 都断开：(108,36)
3. NW 与 SW 都断开：(180,0)
4. NE 与 SE 都断开：(198,0)
5. 其他情况：(18,18)

单个对角缺口不改变中心帧。这一版本保守拒绝八邻域中的任何 active 半砖或斜坡，并报告 `shaped-neighbor`。这部分未覆盖是真实限制，不会伪装成普通网格连接。

蜘蛛网的 opacity 为 0.5，对应 fullbright 下源颜色及 alpha 同时减半。已有原始预乘通道处理应保留；不要额外给 RGB 再乘一次 0.5。Canvas 的字节舍入不是 GPU 位级一致性保证。

## 七种藤蔓

所列七个 ID 都经同一版本的 `DrawVineStrip` 和 `GetTileDrawData` 分支确认。它们默认只按相同类型 framing，采用同一固定变体和四向/对角规则。相邻的其他藤蔓类型不会被猜测成同一 framing 类型。636 也出现在源分支，但本模块只启用当前明确列出的七种。

正常形状格的零风条带绘制，anchor 为 `(worldX*16+8, worldY*16−2)`，origin 为 `(8,2)`，因此规划左上角相对格子为 `(0,−4)`。偶数 worldX 水平翻转；必须使用世界坐标，分块或改变选区不能翻转错位。这里主动冻结风和推力，并不声称气象风速为零时游戏也完全静止。

藤蔓邻居在判断连接前应用已核对的方向形状规则。核心 shape=1 表示半砖，shape=2–5 对应游戏 slope=1–4：

- 上邻居 shape 4/5 断开；shape 1/2/3 且非平台时连接
- 下邻居 shape 1/2/3 断开；shape 4/5 且非平台时连接
- 左邻居 shape 2/4 断开；右邻居 shape 3/5 断开
- 左右半砖且类型不同于当前藤蔓时断开
- 对角使用同类型连接，不套用方向斜坡剔除

其余情况用同类型判断。当前藤蔓格本身有形状时拒绝。平台事实表为 19、427、435–439。没有把未知类型猜成 solid，也没有把藤蔓根的附着资格误作相同纹理连接。

## 源规则与许可边界

以下链接固定到 `8255d34616c780af12079425ac92a0a7aed87d71`，用于说明观察到的功能规则；模块没有复制其实现源码。代码许可不授予 Terraria 美术素材的一般使用或再分发许可，素材条件仍见资源包的权利声明。

- [蜘蛛网八向附着合并](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L83356)，[附着谓词](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L82430)
- [默认 no-attach 数组](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L1498)，[平台循环赋值](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L10168)，[已知类型上界](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L1945)
- [公共帧和对角优先级](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L85692)，[方向与形状归一化](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L82718)
- [蜘蛛网的半强度绘制](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L1086)
- [藤蔓转入条带路径](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L541)，[共同偏移与翻转](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L5074)
- [条带 anchor](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L9206)，[origin 与逐节推进](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L9299)，[自然物体绘制保存相同几何](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/NextNatureRenderer.cs#L23)

## 验证结果与复核范围

```sh
node --test test/static-nature.test.mjs
```

合成测试覆盖连接与对角优先级、平台例外、世界坐标翻转、halo 与边界、半透明贴图在墙前的实际像素合成、方向斜坡、未知类型拒绝和 Tile 保存不变性。翻转与偏移的像素测试用一个独立 Canvas 消费者核对接口，宿主 renderer 仍须执行相同契约并进行集成测试。

对示例地图 SHA-256 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab` 进行只读规划扫描、每格提供完整一格 halo 后：

| 类型         |  总格数 | 规划支持 |
| ------------ | ------: | -------: |
| 51 蜘蛛网    | 151,702 |  138,564 |
| 52 藤蔓      |   5,274 |    5,274 |
| 62 丛林藤蔓  | 221,339 |  221,339 |
| 115 神圣藤蔓 |   2,111 |    2,111 |
| 205 猩红藤蔓 |   5,522 |    5,522 |
| 382 藤蔓花   |   1,542 |    1,542 |
| 528 蘑菇藤蔓 |   9,907 |    9,907 |
| 638 灰烬藤蔓 |  16,558 |   16,558 |

共规划支持 400,817 格；另外 13,138 格蜘蛛网因有形状邻居而明确拒绝。此数字是 planner 结果，不是已经加载真实 PNG 并完成绘制的计数。不能在 inventory 阶段仅凭 type=51 就把全部蜘蛛网记为支持，因为这个判断依赖邻域。

建议人工/集成复核 64×64 区域：蜘蛛网 `(3008,1664)`，内含 991 格已支持蜘蛛网；藤蔓 `(448,1984)`，内含 636 格藤蔓；另一处 `(1728,1024)` 内含 580 格藤蔓。真实资源仍应逐一进行 SHA-256 与裁剪边界验证，并在最终覆盖报告中计入资源/效果失败。
