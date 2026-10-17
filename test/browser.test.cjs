const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'dist');
let server, browser, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: data: blob:; font-src http: data:; style-src http: 'unsafe-inline'; script-src http: 'nonce-mdctest' blob:; worker-src http: blob:; connect-src http: data: blob:;">
        <link rel="stylesheet" href="/katex.min.css"><link rel="stylesheet" href="/webview.css"></head><body>
        <div id="app"></div><script nonce="mdctest">
        window.__MDC_MESSAGES__=[];
        window.acquireVsCodeApi=()=>({postMessage:m=>window.__MDC_MESSAGES__.push(m),getState:()=>null,setState:()=>{}});
        window.__MDC_BOOT__={mode:new URLSearchParams(location.search).get('mode')||'visual',worker:location.origin+'/pdf.worker.min.mjs',directory:location.origin,
          templateUrls:{simple:location.origin+'/assets/templates/simple.svg',academic:location.origin+'/assets/templates/academic.svg',
            technical:location.origin+'/assets/templates/technical.svg',cover:location.origin+'/assets/templates/cover.svg'}};
        </script><script src="/webview.js"></script></body></html>`);
      return;
    }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const file = pathname.startsWith('/assets/templates/') ? path.resolve(__dirname, '..', '.' + pathname) :
      path.resolve(root, '.' + pathname);
    if (!file.startsWith(root) && !pathname.startsWith('/assets/templates/') || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    if (file.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
    if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript');
    if (file.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
    if (file.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
    if (file.endsWith('.woff2')) res.setHeader('Content-Type', 'font/woff2');
    if (file.endsWith('.woff')) res.setHeader('Content-Type', 'font/woff');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

function deliver(page, message) {
  return page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
}
test('visual editing changes only the selected Markdown block', async () => {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '# 标题\n\n第一段文本。\n\n| 列 A | 列 B |\n| --- | --- |\n| 一 | 二 |\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  assert.equal(await page.locator('#documentBody h1').textContent(), '标题');
  assert.equal(await page.locator('#documentBody table td').count(), 2);
  const paragraph = page.locator('#documentBody .md-block .block-content p').first();
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type('新增');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'), { timeout: 5000 });
  const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  assert.equal(edit.expected, '第一段文本。\n');
  assert.match(edit.replacement, /新增/);
  assert.equal(source.slice(0, edit.start), '# 标题\n\n');
  const updated = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  await deliver(page, { type: 'documentChanged', source: updated, version: 2 });
  await deliver(page, { type: 'editAck', id: edit.id, source: updated, version: 2 });
  await page.locator('#documentBody table td').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('新');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length >= 2, { timeout: 5000 });
  const tableEdit = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit')[1]);
  assert.match(tableEdit.expected, /^\| 列 A/);
  assert.match(tableEdit.replacement, /一新/);
  assert.equal(updated.slice(tableEdit.start, tableEdit.end), tableEdit.expected);
  assert.deepEqual(errors, []);
  await page.close();
});

test('manual page break is present in generated export bytes', async () => {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 测试文档\n\n第一页 [示例链接](https://example.com/)\n\n<!-- pagebreak -->\n\n## 第二页\n\n后续内容。\n',
    version: 1, settings: {}, exportSettings: { paper: 'a5', template: 'academic' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const info = await page.locator('#pageInfo').textContent();
  assert.match(info, /\/\s*[2-9]/);
  const boundaries = await page.evaluate(() => window.__MDC_MESSAGES__.findLast(m => m.type === 'pageBoundaries')?.boundaries || []);
  assert.ok(boundaries.some(item => item.type === 'manual'));
  if (process.env.MDC_SCREENSHOT) await page.locator('#pdfPages canvas').first().screenshot({ path: process.env.MDC_SCREENSHOT });
  await page.locator('button[data-action=export]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'savePdf'), { timeout: 10000 });
  const data = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'savePdf').data);
  const bytes = Buffer.from(data, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.includes(Buffer.from('https://example.com/')));
  assert.deepEqual(errors, []);
  await page.close();
});

test('a long paragraph continues across PDF pages', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 长文\n\n' + '这是一段需要自动分页的中文内容。'.repeat(700) + '\n',
    version: 1, settings: {}, exportSettings: { paper: 'a5' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const fragments = await page.locator('#printHost .print-fragment').count();
  assert.ok(fragments > 1, `expected multiple fragments, got ${fragments}`);
  const boundaries = await page.evaluate(() => window.__MDC_MESSAGES__.findLast(m => m.type === 'pageBoundaries')?.boundaries || []);
  assert.ok(boundaries.some(item => item.type === 'automatic'));
  const info = await page.locator('#pageInfo').textContent();
  assert.ok(Number(info.split('/')[1].trim()) >= 2);
  await page.close();
});

test('math, highlighted code, Mermaid and footnotes render safely', async () => {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const source = '# 技术文档\n\n行内 $E=mc^2$。脚注[^n]\n\n$$\na+b=c\n$$\n\n```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n[^n]: 示例脚注\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  assert.ok(await page.locator('#documentBody .katex').count() >= 2);
  assert.ok(await page.locator('#documentBody .hljs').count() >= 1);
  assert.ok(await page.locator('#documentBody .footnotes').count() >= 1);
  await page.waitForFunction(() => document.querySelector('#documentBody .mermaid-source svg'), { timeout: 10000 });
  assert.ok(await page.locator('#documentBody .mermaid-source svg path').count() > 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('task checkbox is editable only in visual mode', async () => {
  const visual = await browser.newPage();
  await visual.goto(base + '/?mode=visual');
  await visual.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  await deliver(visual, { type: 'document', source: '- [ ] 待办\n', version: 1, settings: {}, exportSettings: {}, templates: [] });
  const checkbox = visual.locator('#documentBody input[type=checkbox]');
  assert.equal(await checkbox.isDisabled(), false);
  await checkbox.check();
  await visual.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'), { timeout: 5000 });
  const edit = await visual.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  assert.match(edit.replacement, /\[x\]/);
  await visual.close();

  const preview = await browser.newPage();
  await preview.goto(base + '/?mode=preview');
  await preview.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  await deliver(preview, { type: 'document', source: '- [ ] 待办\n', version: 1, settings: {}, exportSettings: {}, templates: [] });
  assert.equal(await preview.locator('#documentBody input[type=checkbox]').isDisabled(), true);
  assert.equal(await preview.locator('#documentBody [contenteditable]').count(), 0);
  await preview.close();
});

test('split preview offers mode switching inside the preview pane', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=preview');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  assert.ok(await page.locator('button[data-action=split]').evaluate(button => button.classList.contains('selected')));
  await page.locator('button[data-action=visual]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'visual'));
  assert.ok(await page.locator('button[data-action=pdf]').isVisible());
  assert.ok(await page.locator('button[data-action=source]').isVisible());
  await page.close();
});

test('visual link and image dialogs write safe Markdown targets', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const source = '[旧链接](https://example.com/)\n\n![旧说明](./image.png)\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('#documentBody a').first().click();
  await page.locator('#linkText').fill('新链接');
  await page.locator('#linkUrl').fill('https://example.org/');
  await page.locator('button[data-action=updateLink]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'), { timeout: 5000 });
  const linkEdit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  assert.match(linkEdit.replacement, /\[新链接\]\(https:\/\/example\.org\/\)/);
  const updated = source.slice(0, linkEdit.start) + linkEdit.replacement + source.slice(linkEdit.end);
  await deliver(page, { type: 'documentChanged', source: updated, version: 2 });
  await deliver(page, { type: 'editAck', id: linkEdit.id, source: updated, version: 2 });
  await page.locator('#documentBody img').click();
  await page.locator('#imageAlt').fill('新说明');
  await page.locator('#imageUrl').fill('./new-image.png');
  await page.locator('button[data-action=updateImage]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length >= 2, { timeout: 5000 });
  const imageEdit = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit')[1]);
  assert.match(imageEdit.replacement, /!\[新说明\]\(\.\/new-image\.png\)/);
  await page.close();
});
