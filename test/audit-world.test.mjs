import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { fixtureWorld, record } from './fixture.mjs';

test('world texture audit fails closed on missing and undersized atlases while preserving its report', t => {
  const dir = mkdtempSync(join(tmpdir(), 'exploretv-audit-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const world = join(dir, 'world.wld'), assets = join(dir, 'assets'), report = join(dir, 'report.json');
  mkdirSync(assets);
  writeFileSync(world, fixtureWorld({width:3, height:3, columns:Array.from({length:3},()=>[record({type:1,repeats:2})])}).bytes);
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/audit-world.mjs', import.meta.url)), world, assets, report], {encoding:'utf8',timeout:10000});
  assert.notEqual(run().status, 0);
  assert.equal(JSON.parse(readFileSync(report)).missingAssets['Tiles_1.png'], 9);
  writeFileSync(join(assets,'Tiles_1.png'), PNG.sync.write(new PNG({width:1,height:1})));
  assert.notEqual(run().status, 0);
  assert.equal(JSON.parse(readFileSync(report)).invalidCrops['Tiles_1.png'], 9);
  writeFileSync(join(assets,'Tiles_1.png'), PNG.sync.write(new PNG({width:288,height:270})));
  const valid=run(); assert.equal(valid.status, 0, valid.stderr);
  const audit=JSON.parse(readFileSync(report));
  assert.equal(audit.processedCells,9); assert.deepEqual(audit.invalidCrops,{}); assert.deepEqual(audit.missingAssets,{});
});
