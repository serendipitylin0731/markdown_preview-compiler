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
        window.__MDC_BOOT__={mode:new URLSearchParams(location.search).get('mode')||'visual',directory:location.origin,
          templateUrls:{simple:location.origin+'/assets/templates/simple.svg',academic:location.origin+'/assets/templates/academic.svg',
            technical:location.origin+'/assets/templates/technical.svg',cover:location.origin+'/assets/templates/cover.svg',
            'sjtu-red':location.origin+'/assets/templates/sjtu-red.svg', 'sjtu-blue':location.origin+'/assets/templates/sjtu-blue.svg',
            'sjtu-red-cover':location.origin+'/assets/templates/sjtu-red-cover.svg',
            'sjtu-blue-cover':location.origin+'/assets/templates/sjtu-blue-cover.svg',
            'sjtu-red-outline':location.origin+'/assets/templates/sjtu-red-outline.svg',
            'sjtu-blue-outline':location.origin+'/assets/templates/sjtu-blue-outline.svg',
            'sjtu-wordmark':location.origin+'/assets/templates/sjtu-wordmark.png'}};
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
    if (file.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
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

test('PDF uses the editor font and a readable light print palette in a dark theme', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await page.addStyleTag({ content: ':root { --vscode-foreground:#cccccc; --vscode-editor-foreground:#cccccc; --vscode-textCodeBlock-background:#3c3c3c; --vscode-panel-border:#3c3c3c; --vscode-textLink-foreground:#4daafc; }' });
  await deliver(page, { type: 'document', source: '# 字体测试\n\n正文 [链接](https://example.com)\n\n```js\nconst value = 1;\n```\n',
    version: 1, settings: { editorFontFamily: '"DejaVu Sans Mono", "Noto Sans CJK SC", monospace' },
    exportSettings: { fontFamily: 'Arial, sans-serif', titleFontFamily: 'Georgia, serif' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const style = await page.evaluate(() => {
    const content = document.querySelector('#printHost .print-content');
    const heading = content.querySelector('h1');
    const code = content.querySelector('pre');
    const link = content.querySelector('a');
    return { font: getComputedStyle(content).fontFamily, body: getComputedStyle(content).color,
      heading: getComputedStyle(heading).color, code: getComputedStyle(code).color,
      codeBackground: getComputedStyle(code).backgroundColor, link: getComputedStyle(link).color };
  });
  assert.match(style.font, /DejaVu Sans Mono/);
  assert.equal(style.body, 'rgb(32, 36, 42)');
  assert.equal(style.heading, 'rgb(32, 36, 42)');
  assert.equal(style.code, 'rgb(32, 36, 42)');
  assert.equal(style.codeBackground, 'rgb(244, 246, 248)');
  assert.equal(style.link, 'rgb(21, 93, 148)');
  const ink = await page.evaluate(() => {
    const printPage = document.querySelector('#printHost .print-page');
    const code = printPage.querySelector('pre').getBoundingClientRect();
    const heading = printPage.querySelector('h1').getBoundingClientRect();
    const rect = printPage.getBoundingClientRect();
    const canvas = document.querySelector('#pdfPages canvas');
    const context = canvas.getContext('2d');
    const point = (x, y) => context.getImageData(Math.floor((x - rect.left) * canvas.width / rect.width),
      Math.floor((y - rect.top) * canvas.height / rect.height), 1, 1).data;
    const background = [...point(code.right - 8, code.top + 8)].slice(0, 3);
    let darkPixels = 0;
    for (let x = heading.left; x < heading.right; x += 2) {
      for (let y = heading.top; y < heading.bottom; y += 2) {
        const pixel = point(x, y);
        if (pixel[0] < 100 && pixel[1] < 100 && pixel[2] < 100) darkPixels++;
      }
    }
    return { background, darkPixels };
  });
  assert.ok(ink.background.every(value => value > 220), `code background is too dark: ${ink.background}`);
  assert.ok(ink.darkPixels > 15, 'the exported heading should have dark ink');
  await page.close();
});

test('README PDF preview and export keep print colors, margins, and footer without linked CSS', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1250 } });
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await page.addStyleTag({ content: ':root { --vscode-foreground:#d4d4d4; --vscode-editor-foreground:#d4d4d4; --vscode-textCodeBlock-background:#3c3c3c; }' });
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  await deliver(page, { type: 'document', source, version: 1, settings: { editorFontFamily: 'monospace' },
    exportSettings: { marginTop: 30, marginRight: 28, marginBottom: 30, marginLeft: 28 }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  if (process.env.MDC_SCREENSHOT) await page.locator('#pdfPages canvas').first().screenshot({ path: process.env.MDC_SCREENSHOT });
  const layout = await page.evaluate(() => {
    const paper = document.querySelector('#printHost .print-page');
    const body = paper.querySelector('.print-content');
    const title = body.querySelector('h1');
    const footer = paper.querySelector('.print-page-number');
    const pageRect = paper.getBoundingClientRect(), contentRect = body.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect(), footerRect = footer.getBoundingClientRect();
    const canvas = document.querySelector('#pdfPages canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const rectInk = (rect, threshold) => {
      let count = 0;
      for (let y = Math.floor((rect.top - pageRect.top) * canvas.height / pageRect.height); y < Math.ceil((rect.bottom - pageRect.top) * canvas.height / pageRect.height); y += 2)
        for (let x = Math.floor((rect.left - pageRect.left) * canvas.width / pageRect.width); x < Math.ceil((rect.right - pageRect.left) * canvas.width / pageRect.width); x += 2) {
          const i = (y * canvas.width + x) * 4;
          if (pixels[i] < threshold && pixels[i + 1] < threshold && pixels[i + 2] < threshold) count++;
        }
      return count;
    };
    return { marginLeft: contentRect.left - pageRect.left, marginTop: contentRect.top - pageRect.top,
      contentRight: pageRect.right - contentRect.right, contentBottom: pageRect.bottom - contentRect.bottom,
      used: (body.lastElementChild.getBoundingClientRect().bottom - contentRect.top) / contentRect.height,
      titleInk: rectInk(titleRect, 110), footerInk: rectInk(footerRect, 160),
      footerRight: pageRect.right - footerRect.right, footerBottom: pageRect.bottom - footerRect.bottom,
      footerGap: footerRect.top - contentRect.bottom };
  });
  assert.ok(Math.abs(layout.marginLeft - 28 * 96 / 25.4) < 2);
  assert.ok(Math.abs(layout.marginTop - 30 * 96 / 25.4) < 2);
  assert.ok(Math.abs(layout.contentRight - 28 * 96 / 25.4) < 2);
  assert.ok(Math.abs(layout.contentBottom - 30 * 96 / 25.4) < 2);
  assert.ok(layout.used > .9, `first page only ${Math.round(layout.used * 100)}% full`);
  assert.ok(layout.titleInk > 30, `title ink: ${layout.titleInk}`);
  assert.ok(layout.footerInk > 1, `footer ink: ${layout.footerInk}`);
  assert.ok(layout.footerRight < 50 && layout.footerBottom < 40 && layout.footerGap > 20);
  const isolated = await page.evaluate(() => {
    document.querySelector('link[href$="webview.css"]').disabled = true;
    const paper = document.querySelector('#printHost .print-page');
    const content = paper.querySelector('.print-content');
    const number = paper.querySelector('.print-page-number');
    const paperRect = paper.getBoundingClientRect(), contentRect = content.getBoundingClientRect(), numberRect = number.getBoundingClientRect();
    return { left: contentRect.left - paperRect.left, top: contentRect.top - paperRect.top,
      color: getComputedStyle(content.querySelector('h1')).color,
      numberRight: paperRect.right - numberRect.right };
  });
  assert.ok(Math.abs(isolated.left - layout.marginLeft) < 2);
  assert.ok(Math.abs(isolated.top - layout.marginTop) < 2);
  assert.equal(isolated.color, 'rgb(32, 36, 42)');
  assert.ok(isolated.numberRight < 50);
  await page.evaluate(() => document.querySelector('link[href$="webview.css"]').disabled = false);
  await page.locator('button[data-action=settings]').click();
  await page.locator('#set-marginLeft').fill('35');
  await page.locator('#set-marginLeft').dispatchEvent('change');
  await page.locator('button[data-action=saveSettings]').click();
  await page.waitForFunction(() => {
    const paper = document.querySelector('#printHost .print-page');
    const content = paper?.querySelector('.print-content');
    return content && Math.abs(content.getBoundingClientRect().left - paper.getBoundingClientRect().left - 35 * 96 / 25.4) < 2 &&
      document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新');
  }, null, { timeout: 30000 });
  await page.locator('button[data-action=export]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'savePdf'));
  assert.equal(Buffer.from(await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'savePdf').data), 'base64').subarray(0, 5).toString(), '%PDF-');
  await page.close();
});

test('automatic pagination fills the current page before continuing a long paragraph', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '# 分页测试\n\n' + '前面的段落。'.repeat(70) + '\n\n' + '接着连续排版的内容。'.repeat(260) + '\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: { paper: 'a5' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const layout = await page.evaluate(() => [...document.querySelectorAll('#printHost .print-page')].map(page => {
    const content = page.querySelector('.print-content');
    const last = content.lastElementChild;
    let cutLines = 0;
    for (const fragment of content.querySelectorAll('.print-fragment')) {
      const edge = fragment.getBoundingClientRect().bottom;
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) if (rect.top < edge - 2 && rect.bottom > edge + 2) cutLines++;
      }
    }
    return { hasFragment: !!content.querySelector('.print-fragment'),
      cutLines, used: last ? (last.getBoundingClientRect().bottom - content.getBoundingClientRect().top) / content.clientHeight : 0 };
  }));
  assert.ok(layout.length >= 2);
  assert.ok(layout[0].hasFragment, 'the long paragraph should use the remaining space on page one');
  assert.ok(layout[0].used > 0.8, `page one was only ${Math.round(layout[0].used * 100)}% full`);
  assert.ok(layout.every(item => item.cutLines === 0), 'automatic breaks should not cut through text lines');
  const lowerPageInk = await page.evaluate(() => {
    const canvas = document.querySelector('#pdfPages canvas');
    const context = canvas.getContext('2d');
    const top = Math.floor(canvas.height * 0.7);
    const pixels = context.getImageData(0, top, canvas.width, Math.floor(canvas.height * 0.2)).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 120 && pixels[index + 1] < 120 && pixels[index + 2] < 120) count++;
    }
    return count;
  });
  assert.ok(lowerPageInk > 50, 'the exported first page should contain text near its bottom');
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

test('automatic pagination continues a table row by row', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const rows = Array.from({ length: 45 }, (_, index) => `| ${index + 1} | 第 ${index + 1} 行说明 |`).join('\n');
  await deliver(page, { type: 'document', source: '# 表格分页\n\n开头内容。\n\n| 序号 | 说明 |\n| --- | --- |\n' + rows + '\n',
    version: 1, settings: {}, exportSettings: { paper: 'a5' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const pageRows = await page.evaluate(() => [...document.querySelectorAll('#printHost .print-page')]
    .map(item => item.querySelectorAll('.print-content tbody tr').length));
  assert.ok(pageRows.length >= 2);
  assert.ok(pageRows[0] > 3 && pageRows[1] > 0);
  assert.equal(pageRows.reduce((sum, count) => sum + count, 0), 45);
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

test('preview bottom scroll is bounded and does not oscillate on source echo', async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(base + '/?mode=preview');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = Array.from({ length: 35 }, (_, index) => `第 ${index + 1} 段正文。`).join('\n\n');
  await deliver(page, { type: 'document', source, version: 1, settings: { syncScroll: true }, exportSettings: {}, templates: [] });
  await page.locator('.document-scroll').evaluate(pane => pane.scrollTop = pane.scrollHeight);
  await page.waitForTimeout(450);
  const state = await page.evaluate(() => {
    const pane = document.querySelector('.document-scroll');
    const last = document.querySelector('#documentBody .md-block:last-child');
    return { top: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight,
      bottomFraction: (last.getBoundingClientRect().bottom - pane.getBoundingClientRect().top) / pane.clientHeight,
      line: window.__MDC_MESSAGES__.findLast(m => m.type === 'scrollTo')?.line };
  });
  assert.ok(state.max > 0);
  assert.ok(state.bottomFraction > 0.56 && state.bottomFraction < 0.76, `last content at ${state.bottomFraction}`);
  for (let index = 0; index < 5; index++) await deliver(page, { type: 'scrollToLine', line: state.line });
  await page.waitForTimeout(450);
  const finalTop = await page.locator('.document-scroll').evaluate(pane => pane.scrollTop);
  assert.ok(Math.abs(finalTop - state.top) < 2, `scroll shifted from ${state.top} to ${finalTop}`);
  await page.close();
});

test('PDF layout uses a dragged content rectangle and imported font', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const font = { id: 'sample', name: 'Custom.woff2', family: 'mdc-font-sample', url: base + '/fonts/KaTeX_SansSerif-Regular.woff2' };
  await deliver(page, { type: 'document', source: '# 内容\n\n`small`\n\n```txt\nblock\n```\n', version: 1,
    settings: {}, exportSettings: {}, templates: [], fonts: [font] });
  await page.locator('button[data-action=settings]').click();
  assert.equal(await page.locator('#set-marginTop').inputValue(), '24');
  assert.match(await page.locator('#marginText').textContent(), /上 24、右 22、下 24、左 22/);
  assert.equal(await page.locator('#set-fontFamily option').count(), 2);
  await page.locator('#marginSheet').scrollIntoViewIfNeeded();
  const sheet = await page.locator('#marginSheet').boundingBox();
  await page.mouse.click(sheet.x + 18, sheet.y + 26);
  assert.equal(await page.locator('#set-marginLeft').inputValue(), await page.locator('#set-marginRight').inputValue());
  assert.equal(await page.locator('#set-marginTop').inputValue(), await page.locator('#set-marginBottom').inputValue());
  await page.locator('#set-marginRight').fill('36');
  await page.locator('#set-marginRight').dispatchEvent('change');
  assert.equal(await page.locator('#set-marginRight').inputValue(), '36');
  await page.locator('#marginSheet').scrollIntoViewIfNeeded();
  const dragSheet = await page.locator('#marginSheet').boundingBox();
  await page.mouse.move(dragSheet.x + 18, dragSheet.y + 26);
  await page.mouse.down();
  await page.mouse.move(dragSheet.x + dragSheet.width - 25, dragSheet.y + dragSheet.height - 36, { steps: 5 });
  await page.mouse.up();
  await page.locator('#set-fontFamily').selectOption(font.family);
  await page.locator('button[data-action=saveSettings]').click();
  const saved = await page.evaluate(() => window.__MDC_MESSAGES__.findLast(m => m.type === 'saveSettings')?.value);
  assert.ok(saved.marginTop > 25 && saved.marginTop < 50);
  assert.ok(saved.marginRight > 20 && saved.marginRight < 50);
  assert.equal(saved.fontFamily, font.family);
  assert.ok(await page.evaluate(() => [...document.fonts].some(face => face.family === 'mdc-font-sample' && face.status === 'loaded')));
  const codeStyle = await page.locator('#documentBody pre code').evaluate(node => ({
    size: parseFloat(getComputedStyle(node).fontSize), parent: parseFloat(getComputedStyle(node.parentElement.parentElement).fontSize),
    shadow: getComputedStyle(node).textShadow }));
  assert.ok(codeStyle.size < codeStyle.parent);
  assert.equal(codeStyle.shadow, 'none');
  await page.close();
});

test('PDF controls show marker state and expand only when a visual pane exists', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 内容\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await page.locator('button[data-action=pdf]').click();
  await page.locator('button[data-action=breakMarkers]').click();
  assert.equal(await page.locator('button[data-action=breakMarkers]').textContent(), '显示分页标记');
  assert.equal(await page.locator('button[data-action=breakMarkers]').getAttribute('aria-pressed'), 'false');
  await page.locator('button[data-action=fullPdf]').click();
  assert.equal(await page.locator('button[data-action=fullPdf]').textContent(), '返回对照');
  assert.equal(await page.locator('#documentPane').isVisible(), false);
  await page.locator('button[data-action=fullPdf]').click();
  assert.equal(await page.locator('#documentPane').isVisible(), true);
  await page.close();
  const standalone = await browser.newPage();
  await standalone.goto(base + '/?mode=pdf');
  assert.equal(await standalone.locator('button[data-action=fullPdf]').count(), 0);
  await standalone.close();
});

test('visual link and image dialogs write safe Markdown targets', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const source = '[旧链接](https://example.com/)\n\n![旧说明](./image.png)\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('#documentBody a').first().dblclick();
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

test('toolbar table edits can be undone, and table controls follow the caret', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '正文\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  assert.equal(await page.locator('#tableTools').isVisible(), false);
  await page.locator('#documentBody td').first().click();
  await page.locator('#tableTools').waitFor({ state: 'visible' });
  await page.locator('button[data-action=row]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
  const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  const updated = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  assert.equal((updated.match(/\|\s*\|\s*\|/g) || []).length, 1);
  await deliver(page, { type: 'documentChanged', source: updated, version: 2 });
  await deliver(page, { type: 'editAck', id: edit.id, source: updated, version: 2 });
  await page.locator('#documentBody td').first().click();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length === 2);
  const undo = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit')[1]);
  assert.equal(undo.expected, updated);
  assert.equal(undo.replacement, source);
  await page.close();
});

test('code and display math edit in place and typed Markdown renders', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '普通文字\n\n```js\nconst a = 1;\n```\n\n$$\na+b\n$$\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('[data-direct=code]').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // 注释');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
  const codeEdit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  assert.match(codeEdit.replacement, /const a = 1; \/\/ 注释/);
  const updated = source.slice(0, codeEdit.start) + codeEdit.replacement + source.slice(codeEdit.end);
  await deliver(page, { type: 'documentChanged', source: updated, version: 2 });
  await deliver(page, { type: 'editAck', id: codeEdit.id, source: updated, version: 2 });
  await page.locator('[data-direct=math]').fill('a+b=c');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length >= 2);
  const mathEdit = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit')[1]);
  assert.match(mathEdit.replacement, /\$\$\na\+b=c\n\$\$/);
  assert.ok(await page.locator('#documentBody .math-block .katex').count());
  await page.close();

  const typed = await browser.newPage();
  await typed.goto(base + '/?mode=visual');
  await deliver(typed, { type: 'document', source: '正文\n', version: 1, settings: {}, exportSettings: {}, templates: [] });
  await typed.locator('#documentBody p').click();
  await typed.keyboard.press('Control+A');
  await typed.keyboard.type('**加粗**');
  await typed.waitForFunction(() => document.querySelector('#documentBody strong'));
  assert.equal(await typed.locator('#documentBody strong').textContent(), '加粗');
  await typed.close();

  const heading = await browser.newPage();
  await heading.goto(base + '/?mode=visual');
  await deliver(heading, { type: 'document', source: '', version: 1, settings: {}, exportSettings: {}, templates: [] });
  await heading.locator('#documentBody p').click();
  await heading.keyboard.type('# 标题');
  assert.equal(await heading.locator('#documentBody h1').textContent(), '标题');
  await heading.close();
});

test('cover fields and Ctrl wheel PDF zoom use the saved layout', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 标题\n\n正文\n', version: 1, settings: {}, templates: [],
    exportSettings: { cover: true, coverSubtitle: '副标题', coverAuthor: '作者', coverDate: false,
      coverPositions: { title: [25, 30], subtitle: [40, 45], author: [60, 70], date: [50, 80] } } });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  assert.equal(await page.locator('#printHost .cover-subtitle').textContent(), '副标题');
  assert.equal(await page.locator('#printHost .cover-author').textContent(), '作者');
  assert.equal(await page.locator('#printHost .cover-date').count(), 0);
  assert.ok(await page.locator('#printHost .cover-title').evaluate(el => {
    const page = el.closest('.print-page');
    return Math.abs(parseFloat(el.style.left) / page.clientWidth - 0.25) < 0.01;
  }));
  assert.equal(await page.locator('button[data-action=fitWidth]').count(), 0);
  await page.locator('#pdfPages').dispatchEvent('wheel', { ctrlKey: true, deltaY: -100 });
  await page.waitForFunction(() => document.getElementById('zoomLabel')?.textContent === '110%');
  await page.close();
});

test('margin and draggable cover previews follow the selected template and landscape paper', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 交大报告\n\n正文\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await page.locator('button[data-action=settings]').click();
  assert.equal(await page.locator('input[name=template]').count(), 5);
  await page.locator('input[name=template][value=sjtu-red]').check();
  assert.match(await page.locator('#marginSheet').evaluate(el => el.style.backgroundImage), /sjtu-red\.svg/);
  assert.match(await page.locator('#coverSheet').evaluate(el => el.style.backgroundImage), /sjtu-red-cover\.svg/);
  await page.locator('input[name=template][value=sjtu-blue]').check();
  await page.locator('#set-orientation').selectOption('landscape');
  const sheets = await page.evaluate(() => {
    const margin = document.getElementById('marginSheet');
    const cover = document.getElementById('coverSheet');
    const number = document.getElementById('marginPageNumber');
    return { margin: margin.getBoundingClientRect().width, cover: cover.getBoundingClientRect().width,
      marginBackground: margin.style.backgroundImage, coverBackground: cover.style.backgroundImage,
      numberRight: parseFloat(number.style.right), numberBottom: parseFloat(number.style.bottom) };
  });
  assert.ok(sheets.margin > 230 && sheets.cover > 330);
  assert.match(sheets.marginBackground, /sjtu-blue\.svg/);
  assert.match(sheets.coverBackground, /sjtu-blue-cover\.svg/);
  assert.match(await page.locator('#marginSheet .template-outline').getAttribute('src'), /sjtu-blue-outline\.svg/);
  assert.match(await page.locator('#coverSheet .template-outline').getAttribute('src'), /sjtu-blue-outline\.svg/);
  assert.ok(Math.abs(sheets.numberRight - 10 / 297 * 100) < .1);
  assert.ok(Math.abs(sheets.numberBottom - 7 / 210 * 100) < .1);
  const title = page.locator('[data-cover-field=title]');
  await title.scrollIntoViewIfNeeded();
  const before = await title.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 35, before.y + before.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await page.locator('button[data-action=saveSettings]').click();
  const saved = await page.evaluate(() => window.__MDC_MESSAGES__.findLast(m => m.type === 'saveSettings')?.value);
  assert.equal(saved.template, 'sjtu-blue');
  assert.equal(saved.orientation, 'landscape');
  assert.ok(saved.coverPositions.title[0] > 50 && saved.coverPositions.title[1] > 36);
  await page.close();
});

test('landscape Shanghai Jiao Tong pages keep the page number below the template footer', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 交大报告\n\n正文\n', version: 1, settings: {}, templates: [],
    exportSettings: { orientation: 'landscape', template: 'sjtu-red', cover: true } });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const layout = await page.evaluate(() => {
    const pages = [...document.querySelectorAll('#printHost .print-page')];
    const body = pages[1], number = body.querySelector('.print-page-number');
    const coverRect = pages[0].getBoundingClientRect(), dateRect = pages[0].querySelector('.cover-date').getBoundingClientRect();
    const coverOutline = pages[0].querySelector('.template-outline').getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect(), numberRect = number.getBoundingClientRect();
    const bodyOutline = body.querySelector('.template-outline').getBoundingClientRect();
    return { count: pages.length, coverBackground: pages[0].style.backgroundImage, bodyBackground: body.style.backgroundImage,
      width: bodyRect.width, height: bodyRect.height,
      right: bodyRect.right - numberRect.right, bottom: bodyRect.bottom - numberRect.bottom,
      dateBottom: dateRect.bottom, coverOutlineTop: coverOutline.top,
      coverOutlineRatio: coverOutline.width / coverOutline.height,
      outlineRight: bodyRect.right - bodyOutline.right,
      outlineBaseline: (bodyOutline.top + bodyOutline.height * 77 / 90 - bodyRect.top) / bodyRect.height };
  });
  assert.ok(layout.count >= 2);
  assert.match(layout.coverBackground, /sjtu-red-cover\.svg/);
  assert.match(layout.bodyBackground, /sjtu-red\.svg/);
  assert.ok(layout.width > layout.height);
  assert.ok(Math.abs(layout.right - 10 * 96 / 25.4) < 2);
  assert.ok(Math.abs(layout.bottom - 7 * 96 / 25.4) < 2);
  assert.ok(layout.dateBottom < layout.coverOutlineTop, 'cover date should stay above the complete outline');
  assert.ok(Math.abs(layout.coverOutlineRatio - 6) < .05, 'the outline should keep its aspect ratio');
  assert.ok(Math.abs(layout.outlineRight / layout.width - .075) < .01);
  assert.ok(Math.abs(layout.outlineBaseline - 1290 / 1400) < .005);
  if (process.env.MDC_SCREENSHOT) {
    await page.locator('#pdfPages canvas').first().screenshot({ path: process.env.MDC_SCREENSHOT + '-cover.png' });
    await page.locator('#pdfPages canvas').nth(1).screenshot({ path: process.env.MDC_SCREENSHOT + '-body.png' });
  }
  await page.close();
});

test('a chosen template loads on the selected preview block range', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '第一段。\n\n第二段。\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await page.locator('button[data-action=settings]').click();
  assert.equal(await page.locator('.setting-grid > :first-child strong').textContent(), '模板');
  await page.locator('input[name=template][value=academic]').check();
  await page.locator('button[data-action=saveSettings]').click();
  await page.locator('#documentBody p').first().selectText();
  await page.locator('#documentBody p').first().dispatchEvent('mouseup');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveSettings').some(m => m.value.templateRanges?.length));
  const saved = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveSettings').findLast(m => m.value.templateRanges?.length).value);
  assert.deepEqual(saved.templateRanges, [{ start: 0, end: 0, id: 'academic' }]);
  assert.equal(saved.baseTemplate, 'simple');
  await deliver(page, { type: 'documentChanged', source: '前言。\n\n第一段。\n\n第二段。\n', version: 2 });
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveSettings').some(m => m.value.templateRanges?.[0]?.start === 1));
  await page.close();
});

test('Backspace removes a paragraph after its last text is deleted', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '第一段。\n\n第二段。\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('#documentBody p').nth(1).selectText();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
  const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  assert.equal(edit.replacement, '');
  assert.equal(source.slice(0, edit.start) + source.slice(edit.end), '第一段。\n');
  await page.close();
});

test('inline code and math buttons format the selected text', async () => {
  for (const [action, source, expected] of [
    ['inlineCode', '这是代码内容\n', /这是`代码`内容/],
    ['inlineMath', '这是x+1内容\n', /这是\$x\+1\$内容/]
  ]) {
    const page = await browser.newPage();
    await page.goto(base + '/?mode=visual');
    await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
    await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
    await page.locator('#documentBody p').evaluate((node, action) => {
      const text = node.firstChild;
      const range = document.createRange();
      const start = action === 'inlineCode' ? 2 : 2;
      const end = action === 'inlineCode' ? 4 : 5;
      range.setStart(text, start); range.setEnd(text, end);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, action);
    await page.locator(`button[data-action=${action}]`).click();
    await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
    const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
    assert.match(edit.replacement, expected);
    await page.close();
  }
});

test('an existing inline formula edits in place without losing its Markdown source', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '公式 $x+1$ 在正文中。\n', version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('#documentBody .math-inline').dblclick();
  await page.locator('.direct-inline-math').fill('y+2');
  await page.locator('button[data-action=settings]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
  const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  assert.match(edit.replacement, /公式 \$y\+2\$ 在正文中/);
  await page.close();
});

test('visual input syncs automatically and Ctrl S waits for it before saving', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '正文。\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('#documentBody p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('新增');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.some(m => m.type === 'saveDocument')), false);
  await page.keyboard.press('Control+s');
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.some(m => m.type === 'saveDocument')), false);
  const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  const updated = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  await deliver(page, { type: 'documentChanged', source: updated, version: 2 });
  await deliver(page, { type: 'editAck', id: edit.id, source: updated, version: 2 });
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'saveDocument'));
  await deliver(page, { type: 'saveResult', success: true });
  assert.equal(await page.locator('#status').textContent(), 'Markdown 已保存');
  await page.close();
});
