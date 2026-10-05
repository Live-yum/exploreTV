# 示例地图、贴图与快速集成

项目提供 `fixtures/example-world.wld` 和示例渲染实际使用的 342 张 PNG，便于下载后运行。地图为 xindong v315、8400 × 2400 格，文件约 12.5 MB；贴图合计 3857015 字节，来自用户指定的 Terraria 1.4.5.8 TConvert 导出结果。

`example/asset-manifest.json` 记录每张 PNG 的文件名、字节数、SHA-256 和尺寸。选择依据是已验证全图渲染报告中实际加载的 `assetHashes`，不是游戏全部资源，也不是把所有候选贴图打包。这组贴图用于当前示例和当前支持的渲染路径，不保证覆盖其他地图、其他水样式或尚未实现的对象。

## 下载后运行

在项目根目录执行，使用支持项目依赖的 Node.js 环境：

```sh
npm ci
node scripts/serve-viewer.mjs
```

打开 `http://127.0.0.1:4174/`。独立查看器从 `fixtures/example-world.wld`、`example/asset-manifest.json` 和 `example/assets/` 读取示例资源。它和原有 uni-app 功能页使用同一套 `core/`，不是集成到现有 viewer-app 后的成品。

原有 uni-app 页面仍保留手动导入流程：

```sh
npm run dev:h5
```

打开终端给出的 H5 地址，先点“导入 .wld”选择示例地图，把坐标设置为 `x=4448, y=496, width=64, height=40`。再点“导入 PNG 贴图”，从 `example/assets/` 中选择该范围需要的六张：`Tiles_10.png`、`Tiles_19.png`、`Tiles_353.png`、`Tiles_38.png`、`Tiles_4.png`、`Wall_5.png`，最后点“生成场景预览”。也可以从下面生成的本地 `example-assets/` 选择同名文件。

原有页面不会自动选择文件，而且有 48 MiB 贴图缓存限制。不要一次导入全部 342 张：它们的原始 RGBA 加平台图像及 PNG 字节估算约 113.3 MiB，超过该页缓存预算。上述六张估算约 8.4 MiB；切换范围应加载对应的资源子集。TConvert 输出使用“PNG通道：TConvert原始”和“黑底预乘合成”；这不等同于游戏中的实时光照。

## 贴图的权利边界

Terraria 美术素材的权利仍属于 Re-Logic 及相应权利人。项目代码许可和 TConvert 的软件许可不授予这些 PNG 的一般再分发许可。

本示例随完整查看工具附带这 342 张实际必要的贴图，依据 [Re-Logic 官方模组、工具和资源规则](https://forums.terraria.org/index.php?threads/modding-pc-only-rules-guidelines.286/#post-1761) 中工具运行、使用所必需的原游戏内容例外；工具的主要目的不能是重新分发原版游戏内容。具体适用范围见 [贴图说明与权利声明](../example/assets/NOTICE.md)。请保留该声明，不要把此目录当作通用素材包或单独的贴图库发布；换用素材、增加内容或改变用途时应重新核对授权。

## 可选：从自己的 TConvert 输出准备本地资源

如果希望核验自己的合法本地 PNG，或者重新建立示例资源目录：

```sh
node scripts/prepare-example.mjs /absolute/path/to/TConvert-output --check
node scripts/prepare-example.mjs /absolute/path/to/TConvert-output
```

第一条只验证，不写文件。第二条把通过校验的 342 张 PNG 复制到项目根目录的 `example-assets/`；这个目录由 Git 忽略，不属于应用包。输入目录永远只读。命令不会下载资源、读取账号凭据、上传文件或解压未知内容。

可接受以下布局，名称大小写必须准确；也可直接把 `Images` 目录作为输入：

```text
TConvert-output/
  Images/
    Tiles_0.png
    Wall_1.png
    Misc/
      water_0.png
      water_1.png
      water_11.png
```

也支持所有 PNG 在同一层的目录。仅查找清单中的 `Tiles_<id>.png`、`Wall_<id>.png`、`water_<id>.png`，不会递归复制整个游戏目录。同一文件同时出现在多个支持的位置会报错，应提供单一布局。

每个文件必须同时符合清单的字节数、SHA-256、尺寸和有界 PNG 解码检查。重新编码过的 PNG 即使视觉相同，也会因字节哈希不同而被拒绝；此清单用来复现同一份导出结果，不按文件名猜测兼容性。缺文件、CRC 错误、非 RGBA8 或交错 PNG 都会失败。在所有输入和既有输出通过验证前，不写入任何 PNG。

默认安全预算：清单不超过 256 KiB、最多 512 张、每张编码不超过 8 MiB、单边不超过 4096 像素、每张解码 RGBA 不超过 16 MiB、总编码不超过 64 MiB。这里只保留有界的原 PNG 字节，不把全部贴图解码后长期驻留。

需要其他输出位置时可显式指定：

```sh
node scripts/prepare-example.mjs /absolute/path/to/TConvert-output \
  --output /absolute/path/to/my-local-example-assets
```

输入和输出不能相同，也不能互相包含；输出路径中的符号链接、输入目录内部的符号链接均被拒绝。输出中相同哈希的文件会保留，不同内容的同名文件会使操作失败；无关文件不会被覆盖或删除。文件使用排他创建，运行中发生写入失败可能留下已经复制成功的文件，修复原因后可安全重跑。自定义输出目录应自行加入忽略规则，不要误提交未经授权的素材。

`--manifest /path/to/manifest.json` 接受相同结构的自定义清单，供自己的资源集与合成测试使用。它只读取元数据，不执行代码、访问清单提供的链接或扩展路径权限。必要字段是 `schemaVersion: 1`、`inputEncoding: "tconvert-game-raw"` 和非空 `textures` 数组；每项是 `{file, bytes, sha256, width, height}`。文件名只能是上述平面 PNG 名称，不能包含路径。自定义清单不能提高安全预算，也不代表资源获得任何新的使用许可。

## 命令行生成示例画面

以下命令使用可选本地导入的 `example-assets/`；要直接使用随查看器提供的必要资源，将该参数改成 `example/assets`。

局部场景，坐标、宽高的单位都是世界格：

```sh
node scripts/render-world.mjs \
  fixtures/example-world.wld example-assets \
  4448 496 64 40 --effects
```

结果是本地 `artifacts/private-scene.png` 和 `artifacts/private-scene-report.json`。该工具也校验片段保存、重载后的 Tile 数据相等；原世界不会被修改。重复运行会覆盖这些固定名称的输出。

完整世界预览，输出路径显式指定：

```sh
node --expose-gc scripts/render-full-world.mjs \
  fixtures/example-world.wld example-assets artifacts/example-world \
  --expect-world-sha256 d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab \
  --detail surface:4400,448,192,128
```

先加 `--inventory-only` 可以仅检查地图用到的资源；完整渲染的输出、内存边界和覆盖报告见 [全图渲染说明](full-world.md)。成功退出表示处理完成，仍须检查 coverage 中跳过的对象、液体和效果；它是静态 fullbright 贴图近似，不是游戏截图。

## 集成到现有 viewer-app

保持宿主当前的只读世界会话、文件选择、缓存和画布生命周期。可复用 `core/` 以及对应平台的 `adapters/files.js`；不要把 Node CLI 脚本放进 H5 或小程序运行时。下面调用的是当前导出的 API，以小范围预览演示接入点：

```js
import { openWorld, extractSceneRegion } from "./core/world.mjs";
import { planScene, renderScene } from "./core/renderer.mjs";
import { prepareSceneFrames } from "./core/scene-frames.mjs";
import { textureMemoryBytes } from "./core/assets.mjs";
import { saveFragment, loadFragment } from "./core/fragment.mjs";
import { loadTexture, createProcessingCanvas } from "./adapters/files.js";

// worldBytes comes from the host's read-only file/session service.
// Open once per world; retain this index while changing the preview rectangle.
const world = openWorld(worldBytes);
const region = extractSceneRegion(world, {
  x: 4448,
  y: 496,
  width: 64,
  height: 40,
});
const plan = planScene(region, {
  paintEnabled: true,
  liquids: {
    enabled: true,
    waterStyle: 0,
    frame: 0,
    waterfallFrame: 0,
    layer: "foreground",
  },
});

// textureFiles is the host's Map from a canonical filename to a browser File
// or Weixin file descriptor. canvas is the initialized platform Canvas2D node.
const assets = new Map();
let retainedBytes = 0;
for (const name of plan.requiredAssets) {
  const file = textureFiles.get(name);
  if (!file) throw new Error(`Missing texture: ${name}`);
  const image = await loadTexture(file, canvas);
  retainedBytes += textureMemoryBytes(image);
  if (retainedBytes > 48 * 1024 * 1024)
    throw new Error("Preview texture cache exceeds 48 MiB");
  assets.set(name, image);
}

const frames = prepareSceneFrames(plan, assets, createProcessingCanvas, {
  inputEncoding: "tconvert-game-raw",
  opaqueScene: true,
});
let report;
try {
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = false;
  report = renderScene(context, plan, assets, {
    strict: true,
    sceneFrames: frames,
  });
} finally {
  frames.dispose();
}

// Surface report.warnings/support to the user; strict checks resource validity,
// but does not turn unsupported scene features into fully rendered objects.
const savedText = saveFragment(region);
const reloadedFragment = loadFragment(savedText);
```

真实宿主应按可见区域保留、淘汰资源，并在新世界导入、页面退出和预览取消时释放旧缓存。H5 的原功能页使用 `hidpi=false` 避免 uni-app 包装层自动缩放和手动画布尺寸冲突。拖动选择、缩放和世界平移的现有实现位于 `features/scene-explorer/index.vue`。更多数据保留和平台边界见 [集成说明](integration.md)。

示例原地图及 PNG 放在应用源码包之外。尤其不要把约 12.5 MB 世界文件和整套纹理直接复制进微信小程序主包：应通过宿主已经授权的文件来源和按需缓存读取。当前 `npm run build:mp-weixin` 仅证明编译成功；未据此声称示例大地图已在真机完成导入、触摸交互或内存性能验证。保存内容是矩形内的 Tile 数据，不包含箱子物品、告示牌文本、实体或 NPC，也不是整世界写回功能。

## 本地导入回归检查

```sh
node --test test/prepare-example.test.mjs
```

测试使用自行生成的 2 × 2 PNG，覆盖嵌套导出布局、只导入所需文件、重复运行、只校验模式、缺失或损坏文件、路径与大小边界，以及保留用户既有输出；不依赖私有地图或游戏素材。
