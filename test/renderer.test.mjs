import test from 'node:test';
import assert from 'node:assert/strict';
import {planScene,renderScene} from '../core/renderer.mjs';
const tile=(type=1,other={})=>({active:true,type,frameX:null,frameY:null,wall:0,shape:0,...other});
const region=(width,height,cells)=>({rect:{x:0,y:0,width,height},cells,raw:[],version:269});
const mock=()=>{const calls=[];return{calls,save(){calls.push(['save']);},restore(){calls.push(['restore']);},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},closePath(){},drawImage(...a){calls.push(['drawImage',...a]);}};};
test('column-major adjacency uses atlas positions, not frame zero',()=>{
 const p=planScene(region(2,1,[tile(),tile()]));
 assert.deepEqual(p.commands.map(c=>[c.sx,c.sy,c.dx]),[[162,0,0],[216,0,16]]);
 assert.equal(p.support.approximateTiles,2);assert.deepEqual(p.requiredAssets,['Tiles_1.png']);
});
test('wall pass precedes tiles; 32px crop centered on 16px grid',()=>{
 const p=planScene(region(1,1,[tile(1,{wall:1})]));
 assert.deepEqual(p.commands.map(c=>c.kind),['wall','tile']);
 assert.deepEqual([p.commands[0].sx,p.commands[0].sy,p.commands[0].sw,p.commands[0].dx],[324,108,32,-8]);
});
test('wall neighbors connect across wall IDs',()=>{
 const p=planScene(region(2,1,[tile(1,{active:false,wall:1}),tile(1,{active:false,wall:2})]));
 assert.deepEqual(p.commands.map(c=>[c.sx,c.sy]),[[324,0],[432,0]]);
});
test('stored-frame chest retains exact crop coordinates and bottom-row height',()=>{
 const p=planScene(region(1,1,[tile(21,{frameX:36,frameY:18})]));
 assert.deepEqual([p.commands[0].sx,p.commands[0].sy,p.commands[0].sh],[36,18,18]);
 assert.equal(p.support.storedFrames,1);assert.equal(p.support.approximateTiles,0);
});
test('unsupported cells are diagnosed without placeholder sprites',()=>{
 const p=planScene(region(1,1,[tile(999,{frameX:0,frameY:0})]));
 assert.equal(p.commands.length,0);assert.equal(p.support.unsupportedTiles,1);assert.match(p.warnings.join(' '),/999:1/);
});
test('invisible blocks and walls require reveal option',()=>{
 const r=region(1,1,[tile(1,{wall:1,invisibleBlock:true,invisibleWall:true})]);
 assert.equal(planScene(r).commands.length,0);assert.equal(planScene(r,{revealInvisible:true}).commands.length,2);
});
test('half block crops and slope clipping geometry',()=>{
 const p=planScene(region(2,1,[tile(1,{shape:1}),tile(1,{shape:2})]));
 assert.deepEqual([p.commands[0].sh,p.commands[0].dh,p.commands[0].dy],[8,8,8]);
 assert.deepEqual(p.commands[1].clip,[[0,0],[16,16],[0,16]]);
});
test('strict missing-asset failure is atomic; non-strict draws no fallback',()=>{
 const p=planScene(region(1,1,[tile()])),ctx=mock();
 assert.throws(()=>renderScene(ctx,p,new Map(),{strict:true}),/Missing textures/);assert.equal(ctx.calls.length,0);
 const result=renderScene(ctx,p,new Map());assert.equal(result.drawn,0);assert.deepEqual(result.missingAssets,['Tiles_1.png']);
});
test('out-of-bounds texture crop is rejected before strict drawing',()=>{
 const p=planScene(region(1,1,[tile()])),ctx=mock();
 assert.throws(()=>renderScene(ctx,p,new Map([['Tiles_1.png',{width:16,height:16}]]),{strict:true}),/out-of-bounds/);
 assert.equal(ctx.calls.length,0);
});
test('draws supplied image without smoothing and balances context state',()=>{
 const p=planScene(region(1,1,[tile()])),ctx=mock(),asset={width:512,height:512};
 const result=renderScene(ctx,p,new Map([['Tiles_1.png',asset]]),{strict:true});
 assert.equal(result.drawn,1);assert.equal(ctx.imageSmoothingEnabled,false);
 assert.equal(ctx.calls.filter(c=>c[0]==='save').length,ctx.calls.filter(c=>c[0]==='restore').length);
 assert.equal(ctx.calls.find(c=>c[0]==='drawImage')[1],asset);
});
test('preserves raw bytes and derived data while warning about unsupported effects',()=>{
 const r=region(1,1,[tile(1,{paint:3,liquid:255,liquidKind:4,inactive:true})]);r.raw=[new Uint8Array([2,1])];
 const before=JSON.stringify(r);const p=planScene(r);assert.equal(JSON.stringify(r),before);
 assert.equal(p.support.paint,1);assert.equal(p.support.liquid,1);assert.match(p.warnings.join(' '),/unpainted/);
});
test('malformed and over-budget regions fail',()=>{
 assert.throws(()=>planScene(region(2,2,[])),/Invalid/);assert.throws(()=>planScene(region(513,1,[])),/oversized/);
});

