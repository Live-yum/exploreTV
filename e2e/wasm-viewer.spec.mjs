import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4174';
async function openExample(page, suffix = '') {
  await page.goto(origin + '/' + suffix);
  await page.getByRole('button', {name:'打开示例世界', exact:true}).click();
  await expect.poll(async () => page.locator('#viewport').evaluate(e => ({...e.dataset})), {timeout:60000})
    .toMatchObject({busy:'false',worldWidth:'8400',worldHeight:'2400'});
  await expect.poll(async () => Number(await page.locator('#viewport').getAttribute('data-drawn')), {timeout:60000}).toBeGreaterThan(0);
}
async function picture(page) {
  return page.locator('#world-canvas').evaluate(c => c.toDataURL('image/png'));
}

test('actual viewer loads Rust WASM under its CSP and matches the JS-rendered world', async ({page}, info) => {
  test.setTimeout(120000);
  const wasmResponses=[];
  page.on('response', r => {if(r.url().endsWith('.wasm')) wasmResponses.push({status:r.status(),type:r.headers()['content-type']});});
  await openExample(page);
  await expect(page.locator('#viewport')).toHaveAttribute('data-backend','rust-wasm');
  expect(wasmResponses).toContainEqual({status:200,type:'application/wasm'});
  expect(Number(await page.locator('#viewport').getAttribute('data-wasm-memory-bytes'))).toBeLessThanOrEqual(128*1024*1024);
  const wasm = await picture(page);
  const previous = Number(await page.locator('#viewport').getAttribute('data-revision'));
  await page.getByRole('button',{name:'打开示例世界',exact:true}).click();
  await expect.poll(async () => {
    const s = await page.locator('#viewport').evaluate(e => ({...e.dataset}));
    return s.busy === 'false' && Number(s.revision) > previous;
  }, {timeout:60000}).toBe(true);
  expect(await picture(page)).toBe(wasm);
  await page.screenshot({path:`artifacts/wasm-viewer-${info.project.name}.png`,fullPage:true});
  const malformed = Buffer.alloc(32);
  malformed.writeInt32LE(315);
  await page.locator('#world-file').setInputFiles({name:'broken.wld',mimeType:'application/octet-stream',buffer:malformed});
  await expect(page.locator('#load-status')).toContainText('Invalid WLD magic');
  await expect(page.locator('#viewport')).toHaveAttribute('data-backend','rust-wasm');
  expect(await picture(page)).toBe(wasm);
  await openExample(page,'?engine=javascript');
  await expect(page.locator('#viewport')).toHaveAttribute('data-backend','javascript');
  expect(await picture(page)).toBe(wasm);
});

test('unavailable WASM fails back to the JS viewer without losing a world', async ({page}) => {
  test.setTimeout(90000);
  await page.route('**/wasm-core/dist/exploretv_wld_core.wasm', route => route.fulfill({status:404,body:'Unavailable for fallback test'}));
  await openExample(page);
  await expect(page.locator('#viewport')).toHaveAttribute('data-backend','javascript');
  await expect(page.locator('#viewport')).toHaveAttribute('data-fallback-reason',/404/);
  const first = await picture(page);
  const previous = Number(await page.locator('#viewport').getAttribute('data-revision'));
  await page.getByRole('button',{name:'打开示例世界',exact:true}).click();
  await expect.poll(async () => {
    const s = await page.locator('#viewport').evaluate(e => ({...e.dataset}));
    return s.busy === 'false' && Number(s.revision) > previous;
  }, {timeout:60000}).toBe(true);
  expect(await picture(page)).toBe(first);
});
