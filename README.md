# exploreTV · 建筑片段实验室

独立的 Vue3 / uni-app 功能探索：导入 `.wld` → 选择矩形 → 使用真实 PNG Tile/Wall 贴图预览 → 保存并重读验证 Tile 片段。

**当前是部分静态近似渲染，绝非完整 Terraria 游戏窗口等价截图。** 预览不会拿地图色块冒充真实纹理；缺失贴图和未实现对象会明确报告。游戏资源、私有源码和真实地图不随仓库分发。

## Run

```sh
npm ci --ignore-scripts
npm test
CI=1 npm run build:h5
CI=1 npm run build:mp-weixin
node scripts/check-mp.mjs
npm run dev:h5
```

从合法来源导入 `Tiles_N.png`、`Wall_N.png`。输入矩形坐标与宽高，生成预览；保存 `.tvtiles.json` 可重新导入。原始世界只读，不自动联网上传文件。

## Verification

GitHub Actions runs bounded parser/fragment tests, sprite command tests, a20.16M-cell synthetic performance case, H5 and Weixin builds, platform leakage checks, and a Chromium UI flow. Public CI uses original synthetic fixture/art only. It does not silently skip a requested real-world test or claim its synthetic test world is game-loadable.

For a user-supplied real map and textures:

```sh
npm run test:real -- /path/world.wld expected-sha256
node scripts/render-world.mjs /path/world.wld /path/Images 4180 631 48 32
```

Local reports and screenshots go to ignored `artifacts/`. Never commit private worlds or game textures without explicit publication authorization. Screenshots generated from private input are also not public CI artifacts by default.

- [Rendering scope](docs/rendering-scope.md)
- [Data contract and mini-program integration](docs/integration.md)

The fragment retains all serialized Tile fields, including flags/frames/coatings. It excludes non-Tile sections: chest contents, signs, tile entities, NPCs. Multi-cell objects crossing the selection are truncated. Restore validation is into an independent Tile grid, not a game-loadable `.wld` writer.

No deployment, GitHub Pages, app-store publication, signing, or credential changes are included.
