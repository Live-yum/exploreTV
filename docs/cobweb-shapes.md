# 蜘蛛网的形状邻居补全

`core/cobweb-shapes.mjs` 是原创、只读的蜘蛛网邻域连接 helper。它补全普通形状 type 51 蜘蛛网周围的半砖与斜坡，不实现游戏物理，不改变 Tile 数据或保存字节。当前蜘蛛网自身的形状限制、固定变体 0、半透明和 fullbright 静态绘制限制仍由 `static-nature.mjs` 管理。

此模块已接入主 planner 的 `planStaticNature`，保留未知类型、异常形状和缺失邻域的明确拒绝。

## 接入

```js
import { cobwebConnects } from "./cobweb-shapes.mjs";
```

在 `planStaticNature` 收集八个邻居时，仅删除 `tile.type === 51 && shape` 返回 `shaped-neighbor` 的特殊拒绝。保留所有 active 邻居的类型范围与 shape 0–5 校验，以及 region、halo、世界边界、当前格、存储帧等校验。未知形状不能变成空气。

把连接计算改为下面的逻辑，继续使用原有 `selectFrame`、源坐标和绘制返回值：

```js
const connected = neighbors.map((neighbor, index) => {
  if (tile.type === 51)
    return cobwebConnects(neighbor, index, noAttach, {
      revealInvisible,
      invisibleBlock: tile.invisibleBlock,
    });
  if (!neighbor.active) return false;
  if (!revealInvisible && !!neighbor.invisibleBlock !== !!tile.invisibleBlock)
    return false;
  return vineConnects(neighbor, index, tile.type);
});
```

`noAttach` 是原模块现有的 `Set(COBWEB_NO_ATTACH)`，不重复保存另一份事实表。八方向索引为 N、W、E、S、NW、NE、SW、SE。helper 对无效方向、缺邻居、未知 active 类型、异常 active shape、缺事实表抛错；主 planner 的既有校验必须先返回明确拒绝原因。inactive Tile 不因残留 type/shape 数据参与连接，actuated 但仍 active 的 Tile 则遵循原 framing 的 active 规则。

主模块原来的“蜘蛛网拒绝 shaped-neighbor”测试也应更新为方向性的预期；保留异常形状拒绝测试。原 `docs/static-nature.md` 的保守限制与计数应在正式集成后更新。不要仅在资源清单中把 type 51 无条件计为支持。

## 连接顺序

core shape 1 是半砖，2–5 对应游戏 slope 1–4。针对普通形状的当前蜘蛛网：

1. 先按实际邻居的形状去掉不接触中心格的四向面：上方 shape 4/5；左方 2/4；右方 3/5；下方 1/2/3。
2. 上方 shape 1/2/3，或下方 shape 4/5，若不是平台，则把临时连接类型归一为蜘蛛网 51。这样原类型即使在 no-attach 表中，也能由这条水平接触规则连接。
3. 左右半砖仅当原始类型也是 51 才保留。其他类型的侧半砖不连接。
4. 对角不套用四向形状排除，也不强制改成 51。八方向依次以归一后的类型执行 no-attach 判断。
5. 最后按原始邻居与当前格的隐形标志剔除不同组；显影模式绕过这一剔除。剔除后的邻居不能被形状规则重新接回。每个对角独立剔除。

平台事实为 19、427、435–439，所有位置与形状均保持 no-attach。不能把“非平台”替换为“solid”，也不能把所有有形状的邻居当成空气或完整方块。

这里不保留临时 stone/dirt 类型重写数组，因为固定版本的 stone 别名 63–68、130、131、566 以及 dirt 别名 668 都不在 no-attach/platform 表中，且均不是 51。它们重写后的连接布尔值与原类型相同；侧半砖的例外仍必须比较原始类型。type 697 在自己 framing 时归一成蜘蛛网，不意味着它作为邻居时是 type 51 的同类型侧半砖。

## 固定源依据

所有功能规则均核对同一版本 `8255d34616c780af12079425ac92a0a7aed87d71`，代码为独立实现；未复制第三方实现或分发源文件。纹理的使用权限仍依照宿主资源包的说明。

- [八邻域读取与四向 slope 面剔除](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L82718)
- [形状归一、平台排除与 halfBrick 顺序](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L82919)
- [蜘蛛网的八向 no-attach 合并](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L83356)
- [默认帧之前的最终剔除及第 0 变体坐标](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L85679)
- [八个独立的隐形状态比较](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L86127)
- [平台 ID 集合](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L243)、[stone 类型初始化](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L8135)、[131 的 stone 标志](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L7611)

## 验证

```sh
node --test test/cobweb-shapes.test.mjs
EXPLORETV_COBWEB_REAL_WORLD=1 node --test test/cobweb-shapes.test.mjs
```

默认有 12 项合成测试通过；第 13 项仅在显式启用且私有地图/纹理均存在时运行。覆盖：各方向六种形状；每个 no-attach 类型的归一顺序；七种平台的全部八向/六形状组合；形状对角负例；隐形剔除与显影；actuated；256 个八邻域连接 mask；成对对角缺口优先级；全部 754 个已知类型的无形状回归；Tile 的全部保存字段、halo、原始字节和 fragment round trip 不变。

真实地图 SHA-256 为 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`。只读扫描结果：

| 项目                                         |    格数 |
| -------------------------------------------- | ------: |
| 全部蜘蛛网                                   | 151,702 |
| 旧规则已支持且帧保持不变                     | 138,564 |
| 本 helper 新覆盖的 shaped-neighbor           |  13,138 |
| 与忽略形状、当完整方块的错误结果有不同源裁剪 |   6,654 |

示例修正坐标：(34,882) 从错误的 (18,36) 源裁剪改为 (0,72)；(63,2163) 从 (18,36) 改为 (18,72)；(88,855) 从 (18,18) 改为 (72,0)。这表明补全需要改变真实连接选择，而不只是放宽拒绝。

真实 `Tiles_51.png` 的 SHA-256 为 `a799f2de51618f49ffe95b8917248fb181e4213ae3cc7456a1324502c543b240`，尺寸 234×90。测试实际解码该 PNG，并验证扫描得到的 20 种 16×16 源裁剪全部在界内且有非零 alpha。世界输入字节的扫描前后哈希相同。

这些是源规则和贴图裁剪验证；没有游戏像素级截图 oracle。主 planner 集成后已重跑真实世界覆盖审计与受影响测试；宿主 GUI 与导出仍须在提交版本上验收。
