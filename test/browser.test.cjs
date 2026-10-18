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
            technical:location.origin+'/assets/templates/technical.svg',cover:location.origin+'/assets/templates/cover.svg'}};
        for(const color of ['red','blue']) for(const paper of ['a4','a5','letter'])
          for(const orientation of ['portrait','landscape']) for(const cover of [false,true]) {
            const name='sjtu-'+color+'-'+paper+'-'+orientation+(cover?'-cover':'');
            window.__MDC_BOOT__.templateUrls[name]=location.origin+'/assets/templates/'+name+'.png';
          }
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

test('IME composition and new paragraphs sync without phonetic text or duplicate lines', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  let source = '开头\n\n## 使用\n';
  let version = 1;
  let editCount = 0;
  await deliver(page, { type: 'document', source, version, settings: {}, exportSettings: {}, templates: [] });
  const paragraph = page.locator('#documentBody .md-block').first().locator('p');
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const child = document.querySelector('#documentBody .md-block .block-content').lastElementChild;
    child.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    child.textContent = "wei'shen";
    child.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: "wei'shen", isComposing: true }));
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length), 0);
  await page.keyboard.press('Control+s');
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveDocument').length), 0);
  await page.evaluate(() => {
    const child = document.querySelector('#documentBody .md-block .block-content').lastElementChild;
    child.textContent = '为什么';
    child.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '为什么' }));
    child.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '为什么' }));
  });
  const sync = async expected => {
    await page.waitForFunction(count => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length > count, editCount, { timeout: 5000 });
    const edit = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').at(-1));
    editCount++;
    source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
    assert.equal(source, expected);
    version++;
    await deliver(page, { type: 'documentChanged', source, version });
    await deliver(page, { type: 'editAck', id: edit.id, source, version });
  };
  await sync('开头\n\n为什么\n\n## 使用\n');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'saveDocument'), { timeout: 5000 });
  assert.equal(await page.locator('#documentBody .md-block').count(), 3);
  await page.locator('#documentBody .md-block').nth(1).locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('呀');
  await sync('开头\n\n为什么呀\n\n## 使用\n');
  await page.keyboard.press('Enter');
  await page.keyboard.type('新');
  await sync('开头\n\n为什么呀\n\n新\n\n## 使用\n');
  await page.keyboard.type('段');
  await sync('开头\n\n为什么呀\n\n新段\n\n## 使用\n');
  assert.equal(await page.locator('#documentBody .md-block').count(), 4);
  await page.locator('#documentBody .md-block').nth(2).locator('p').selectText();
  await page.keyboard.press('Backspace');
  await sync('开头\n\n为什么呀\n\n## 使用\n');
  await page.locator('#documentBody .md-block').nth(1).locator('p').selectText();
  await page.keyboard.press('Backspace');
  await sync('开头\n\n## 使用\n');
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

test('PDF lays out consecutive Chinese characters in one Songti font run', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '中文排版整齐测试\n\n中文宋体和 English 混排。\n', version: 1,
    settings: { editorFontFamily: '"DejaVu Sans Mono", monospace' }, exportSettings: { fontSize: 18 }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const layout = await page.evaluate(() => {
    const paper = document.querySelector('#printHost .print-page');
    const content = paper.querySelector('.print-content');
    const span = content.querySelector('p .print-chinese');
    const node = span.firstChild;
    const rects = [...node.textContent].map((_, i) => {
      const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width };
    });
    return { text: span.textContent, font: getComputedStyle(span).fontFamily, bodyFont: getComputedStyle(content).fontFamily,
      rects, scale: document.querySelector('#pdfPages canvas').width / paper.offsetWidth };
  });
  assert.equal(layout.text, '中文排版整齐测试');
  assert.match(layout.font, /Songti SC.*SimSun.*Noto Serif CJK SC/);
  assert.match(layout.bodyFont, /DejaVu Sans Mono/);
  assert.ok(layout.scale >= 1.9);
  assert.ok(Math.max(...layout.rects.map(rect => rect.top)) - Math.min(...layout.rects.map(rect => rect.top)) < 0.5);
  assert.ok(Math.max(...layout.rects.map(rect => rect.width)) - Math.min(...layout.rects.map(rect => rect.width)) < 0.5);
  await page.close();
});

test('PDF embeds both relative and web images supplied by the extension host', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '![本地](./assets/logo.png)\n\n![网页](https://example.invalid/logo.png)\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'resolveImage').length === 2, { timeout: 5000 });
  const requests = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'resolveImage'));
  assert.deepEqual(requests.map(request => request.source).sort(), ['./assets/logo.png', 'https://example.invalid/logo.png']);
  const data = `data:image/png;base64,${fs.readFileSync(path.resolve(__dirname, '..', 'assets/logo.png')).toString('base64')}`;
  for (const request of requests) await deliver(page, { type: 'imageResolved', id: request.id, data });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const images = await page.evaluate(() => {
    const paper = document.querySelector('#printHost .print-page');
    const canvas = document.querySelector('#pdfPages canvas');
    const context = canvas.getContext('2d');
    return [...paper.querySelectorAll('.print-content img')].map(img => {
      const rect = img.getBoundingClientRect(), pageRect = paper.getBoundingClientRect();
      const x = Math.floor((rect.left - pageRect.left) * canvas.width / pageRect.width);
      const y = Math.floor((rect.top - pageRect.top) * canvas.height / pageRect.height);
      const width = Math.max(1, Math.floor(rect.width * canvas.width / pageRect.width));
      const height = Math.max(1, Math.floor(rect.height * canvas.height / pageRect.height));
      const pixels = context.getImageData(x, y, width, height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 150 && pixels[i + 1] < 150 && pixels[i + 2] < 150) ink++;
      return { alt: img.alt, source: img.dataset.originalSrc, loaded: img.complete && img.naturalWidth === 256,
        dataUrl: img.src.startsWith('data:image/png;base64,'), ink };
    });
  });
  assert.equal(images.length, 2);
  assert.ok(images.every(image => image.loaded && image.dataUrl && image.ink > 200), JSON.stringify(images));
  assert.deepEqual(images.map(image => image.source), ['./assets/logo.png', 'https://example.invalid/logo.png']);
  await page.close();
});

test('PDF moves a picture to the next page and scales an oversized picture without cropping', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 1800;
    const context = canvas.getContext('2d');
    context.fillStyle = '#eeeeee'; context.fillRect(0, 0, 400, 1800);
    context.fillStyle = '#0044ff'; context.fillRect(0, 0, 400, 100);
    context.fillStyle = '#ff2200'; context.fillRect(0, 1700, 400, 100);
    const tall = canvas.toDataURL('image/png');
    canvas.height = 500;
    context.fillStyle = '#00aa44'; context.fillRect(0, 0, 400, 500);
    return { tall, regular: canvas.toDataURL('image/png') };
  });
  const source = `${('填充内容'.repeat(12) + '\n\n').repeat(14)}图片前文字 ![普通图片](./regular.png) 图片后文字\n\n![完整图片](./portrait.png)\n`;
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: { fontSize: 18 }, templates: [] });
  await page.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'resolveImage').length === 2);
  const requests = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'resolveImage'));
  for (const request of requests) await deliver(page, { type: 'imageResolved', id: request.id,
    data: request.source.endsWith('regular.png') ? imageData.regular : imageData.tall });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const layout = await page.evaluate(() => {
    const pages = [...document.querySelectorAll('#printHost .print-page')];
    const images = [...document.querySelectorAll('#printHost .print-content img')].map(image => {
      const imagePage = image.closest('.print-page');
      const rect = image.getBoundingClientRect();
      const area = image.closest('.print-content').getBoundingClientRect();
      return { page: pages.indexOf(imagePage), alt: image.alt,
        top: rect.top, bottom: rect.bottom, areaTop: area.top, areaBottom: area.bottom,
        width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    });
    return { images, fragments: document.querySelectorAll('#printHost .print-fragment img').length };
  });
  assert.equal(layout.images.length, 2);
  assert.ok(layout.images[0].page > 0, `image stayed on a partly filled page: ${JSON.stringify(layout)}`);
  assert.ok(layout.images[1].page > layout.images[0].page, JSON.stringify(layout));
  assert.equal(layout.fragments, 0);
  for (const image of layout.images) {
    assert.ok(image.top >= image.areaTop - 2 && image.bottom <= image.areaBottom + 2, JSON.stringify(layout));
    assert.ok(Math.abs(image.width / image.height - image.naturalWidth / image.naturalHeight) < 0.005);
  }
  assert.ok(Math.abs(layout.images[0].height - 500) < 1, JSON.stringify(layout));
  assert.ok(layout.images[1].height < layout.images[1].naturalHeight);
  const lastPage = layout.images[1].page + 1;
  await page.locator(`#pdfPages .pdf-page-slot[data-page="${lastPage}"]`).scrollIntoViewIfNeeded();
  await page.waitForFunction(pageNumber => !!document.querySelector(`#pdfPages .pdf-page-slot[data-page="${pageNumber}"] canvas`), lastPage);
  const colors = await page.evaluate(pageNumber => {
    const image = document.querySelector('#printHost img[alt="完整图片"]');
    const rect = image.getBoundingClientRect();
    const paper = image.closest('.print-page').getBoundingClientRect();
    const canvas = document.querySelector(`#pdfPages .pdf-page-slot[data-page="${pageNumber}"] canvas`);
    const pixel = y => {
      const x = Math.floor((rect.left + rect.width / 2 - paper.left) * canvas.width / paper.width);
      const py = Math.floor((y - paper.top) * canvas.height / paper.height);
      return [...canvas.getContext('2d').getImageData(x, py, 1, 1).data].slice(0, 3);
    };
    return { first: pixel(rect.top + 10), last: pixel(rect.bottom - 10) };
  }, lastPage);
  assert.ok(colors.first[2] > 150 && colors.first[0] < 100, JSON.stringify(colors));
  assert.ok(colors.last[0] > 150 && colors.last[2] < 100, JSON.stringify(colors));
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
  assert.equal(await page.locator('button[data-action=source]').count(), 0);
  assert.equal(await page.locator('button[data-action=settings]').isVisible(), false);
  assert.equal(await page.locator('button[data-action=export]').isVisible(), false);
  await page.close();
});

test('PDF actions appear only while PDF preview is open', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  assert.equal(await page.locator('button[data-action=settings]').isVisible(), false);
  await page.locator('button[data-action=pdf]').click();
  assert.equal(await page.locator('button[data-action=settings]').isVisible(), true);
  assert.equal(await page.locator('button[data-action=export]').isVisible(), true);
  await page.locator('button[data-action=pdf]').click();
  assert.equal(await page.locator('button[data-action=settings]').isVisible(), false);
  await page.close();
});

test('template import requires a body image and limits paper choices to supplied variants', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 封面标题\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await page.locator('button[data-action=settings]').click();
  assert.equal(await page.locator('#set-coverDateText').inputValue(), await page.evaluate(() => new Date().toLocaleDateString('zh-CN')));
  await page.locator('button[data-action=importTemplate]').click();
  assert.equal(await page.locator('button[data-action=saveTemplateImport]').isDisabled(), true);
  await page.locator('#templateImportName').fill('实验模板');
  await page.locator('button[data-action=pickTemplateImage][data-slot=a5-landscape-body]').click();
  assert.ok(await page.evaluate(() => window.__MDC_MESSAGES__.some(m => m.type === 'pickTemplateImage' && m.slot === 'a5-landscape-body')));
  await deliver(page, { type: 'templateImagePicked', slot: 'a5-landscape-body', name: 'inside.png', url: base + '/assets/templates/simple.svg' });
  assert.equal(await page.locator('button[data-action=saveTemplateImport]').isEnabled(), true);
  await page.locator('button[data-action=saveTemplateImport]').click();
  assert.ok(await page.evaluate(() => window.__MDC_MESSAGES__.some(m => m.type === 'saveTemplateImport' && m.name === '实验模板')));
  await deliver(page, { type: 'templates', importedId: 'custom-a5', templates: [{ id: 'custom-a5', name: '实验模板', variants: {
    'a5-landscape': { bodyUrl: base + '/assets/templates/simple.svg' }
  } }] });
  assert.equal(await page.locator('input[name=template][value=custom-a5]').isChecked(), true);
  assert.equal(await page.locator('#set-paper').inputValue(), 'a5');
  assert.equal(await page.locator('#set-orientation').inputValue(), 'landscape');
  assert.equal(await page.locator('#set-paper option[value=a4]').evaluate(option => option.disabled), true);
  assert.equal(await page.locator('#set-orientation option[value=portrait]').evaluate(option => option.disabled), true);
  assert.match(await page.locator('#coverSheet').evaluate(el => el.style.backgroundImage), /simple\.svg/);
  await page.locator('#set-coverDateText').fill('2026 年 10 月 18 日');
  await page.locator('button[data-action=saveSettings]').click();
  const saved = await page.evaluate(() => window.__MDC_MESSAGES__.findLast(m => m.type === 'saveSettings')?.value);
  assert.equal(saved.coverDateText, '2026 年 10 月 18 日');
  assert.equal(saved.paper, 'a5');
  assert.equal(saved.orientation, 'landscape');
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
  await page.locator('button[data-action=pdf]').click();
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
  assert.equal(await page.locator('#printHost .cover-title').evaluate(el => getComputedStyle(el).fontWeight), '700');
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
  await page.locator('button[data-action=pdf]').click();
  await page.locator('button[data-action=settings]').click();
  assert.equal(await page.locator('input[name=template]').count(), 5);
  await page.locator('input[name=template][value=sjtu-red]').check();
  assert.match(await page.locator('#marginSheet').evaluate(el => el.style.backgroundImage), /sjtu-red-a4-portrait\.png/);
  assert.match(await page.locator('#coverSheet').evaluate(el => el.style.backgroundImage), /sjtu-red-a4-portrait-cover\.png/);
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
  assert.match(sheets.marginBackground, /sjtu-blue-a4-landscape\.png/);
  assert.match(sheets.coverBackground, /sjtu-blue-a4-landscape-cover\.png/);
  assert.equal(await page.locator('#marginSheet .template-outline, #marginSheet .template-wordmark, #marginSheet .template-footer-line').count(), 0);
  assert.equal(await page.locator('#coverSheet .template-outline, #coverSheet .template-wordmark, #coverSheet .template-footer-line').count(), 0);
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
    const bodyRect = body.getBoundingClientRect(), numberRect = number.getBoundingClientRect();
    return { count: pages.length, coverBackground: pages[0].style.backgroundImage, bodyBackground: body.style.backgroundImage,
      width: bodyRect.width, height: bodyRect.height,
      right: bodyRect.right - numberRect.right, bottom: bodyRect.bottom - numberRect.bottom,
      dateBottom: dateRect.bottom, coverMotifTop: coverRect.top + coverRect.height * .83,
      artworkElements: pages.reduce((total, page) => total + page.querySelectorAll('.template-outline, .template-wordmark, .template-footer-line').length, 0) };
  });
  assert.ok(layout.count >= 2);
  assert.match(layout.coverBackground, /sjtu-red-a4-landscape-cover\.png/);
  assert.match(layout.bodyBackground, /sjtu-red-a4-landscape\.png/);
  assert.ok(layout.width > layout.height);
  assert.ok(Math.abs(layout.right - 10 * 96 / 25.4) < 2);
  assert.ok(Math.abs(layout.bottom - 7 * 96 / 25.4) < 2);
  assert.ok(layout.dateBottom < layout.coverMotifTop, 'cover date should stay above the complete outline');
  assert.equal(layout.artworkElements, 0, 'the artwork should be baked into the background PNG');
  assert.equal(await page.locator('#printHost .print-content h1').first().evaluate(el => getComputedStyle(el).fontWeight), '700');
  const motifInk = await page.locator('#pdfPages canvas').nth(1).evaluate(canvas => {
    const context = canvas.getContext('2d');
    const x0 = Math.floor(canvas.width * .45), x1 = Math.floor(canvas.width * .9);
    const y0 = Math.floor(canvas.height * .82), y1 = Math.floor(canvas.height * .93);
    const pixels = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 130 && pixels[i] > pixels[i + 1] * 1.5 && pixels[i] > pixels[i + 2] * 1.4) count++;
    return count;
  });
  assert.ok(motifInk > 150, `red motif missing from PDF preview: ${motifInk} pixels`);
  if (process.env.MDC_SCREENSHOT) {
    await page.locator('#pdfPages canvas').first().screenshot({ path: process.env.MDC_SCREENSHOT + '-cover.png' });
    await page.locator('#pdfPages canvas').nth(1).screenshot({ path: process.env.MDC_SCREENSHOT + '-body.png' });
  }
  await page.close();
});

test('blue Shanghai Jiao Tong seal and motif are blue in the generated PDF preview', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 交大报告\n\n正文\n', version: 1, settings: {}, templates: [],
    exportSettings: { orientation: 'landscape', template: 'sjtu-blue', cover: true } });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const ink = await page.locator('#pdfPages canvas').first().evaluate(canvas => {
    const context = canvas.getContext('2d');
    const countBlue = (x0, y0, x1, y1) => {
      const pixels = context.getImageData(Math.floor(x0 * canvas.width), Math.floor(y0 * canvas.height),
        Math.floor((x1 - x0) * canvas.width), Math.floor((y1 - y0) * canvas.height)).data;
      let blue = 0, red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 2] > pixels[i] * 1.45 && pixels[i + 1] > pixels[i] * 1.25) blue++;
        if (pixels[i] > pixels[i + 2] * 1.45 && pixels[i] > pixels[i + 1] * 1.3) red++;
      }
      return { blue, red };
    };
    return { seal: countBlue(.04, .03, .3, .115), motif: countBlue(.45, .82, .9, .93) };
  });
  assert.ok(ink.seal.blue > 50 && ink.seal.red === 0, `expected blue seal in PDF preview, got ${JSON.stringify(ink.seal)}`);
  assert.ok(ink.motif.blue > 150 && ink.motif.red === 0, `expected blue motif in PDF preview, got ${JSON.stringify(ink.motif)}`);
  assert.match(await page.locator('#printHost .print-page').first().evaluate(el => el.style.backgroundImage), /sjtu-blue-a4-landscape-cover\.png/);
  if (process.env.MDC_SCREENSHOT) await page.locator('#pdfPages canvas').first().screenshot({ path: process.env.MDC_SCREENSHOT + '-blue.png' });
  await page.close();
});

test('all composed Shanghai Jiao Tong backgrounds keep the half-width motif on the right', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=preview');
  const results = await page.evaluate(async () => {
    const checks = [];
    for (const color of ['red', 'blue']) for (const paper of ['a4', 'a5', 'letter']) {
      for (const orientation of ['portrait', 'landscape']) for (const cover of [false, true]) {
        const name = `sjtu-${color}-${paper}-${orientation}${cover ? '-cover' : ''}`;
        const image = new Image();
        image.src = location.origin + '/assets/templates/' + name + '.png';
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const x0 = Math.floor(canvas.width * .3), x1 = Math.floor(canvas.width * .93);
        const y0 = Math.floor(canvas.height * .82), y1 = Math.floor(canvas.height * .915);
        const pixels = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let minX = canvas.width, count = 0;
        for (let y = 0; y < y1 - y0; y++) for (let x = 0; x < x1 - x0; x++) {
          const i = (y * (x1 - x0) + x) * 4;
          const red = pixels[i], green = pixels[i + 1], blue = pixels[i + 2];
          const ink = color === 'red' ? red > 130 && red > green * 1.5 && red > blue * 1.4 :
            blue > red * 1.45 && green > red * 1.25;
          if (ink) { count++; minX = Math.min(minX, x0 + x); }
        }
        checks.push({ name, minX: minX / canvas.width, count, orientation });
      }
    }
    return checks;
  });
  assert.equal(results.length, 24);
  for (const result of results) {
    assert.ok(result.count > 200, `${result.name}: motif missing`);
    assert.ok(result.minX > (result.orientation === 'landscape' ? .68 : .6), `${result.name}: motif is wider than half size`);
  }
  await page.close();
});

test('a chosen template loads on the selected preview block range', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '第一段。\n\n第二段。\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await page.locator('button[data-action=pdf]').click();
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

test('deleting all visible text removes its Markdown block, including the first character', async () => {
  for (const scenario of [
    { source: '第一段。\n\n第二段。\n', selector: '#documentBody p', index: 0, expected: '第二段。\n' },
    { source: '第一段。\n\n第二段。\n\n第三段。\n', selector: '#documentBody p', index: 1, expected: '第一段。\n\n第三段。\n' },
    { source: '第一段。\n\n第二段。\n', selector: '#documentBody p', index: 1, expected: '第一段。\n' },
    { source: '# 标题\n', selector: '#documentBody h1', index: 0, expected: '' },
    { source: '甲\n', selector: '#documentBody p', index: 0, expected: '', caret: 'end' },
    { source: '乙\n', selector: '#documentBody p', index: 0, expected: '', caret: 'start', key: 'Delete' }
  ]) {
    const page = await browser.newPage();
    await page.goto(base + '/?mode=visual');
    await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
    await deliver(page, { type: 'document', source: scenario.source, version: 1, settings: {}, exportSettings: {}, templates: [] });
    const line = page.locator(scenario.selector).nth(scenario.index);
    if (scenario.caret) { await line.click(); await page.keyboard.press(scenario.caret === 'end' ? 'End' : 'Home'); }
    else await line.selectText();
    await page.keyboard.press(scenario.key || 'Backspace');
    await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
    const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
    const next = scenario.source.slice(0, edit.start) + edit.replacement + scenario.source.slice(edit.end);
    assert.equal(next, scenario.expected, `failed to remove ${JSON.stringify(scenario.source)}`);
    await deliver(page, { type: 'documentChanged', source: next, version: 2 });
    await deliver(page, { type: 'editAck', id: edit.id, source: next, version: 2 });
    assert.equal((await page.locator('#documentBody').textContent()).replace(/\s+/g, ''),
      scenario.expected.replace(/\s+/g, ''));
    await page.close();
  }
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
  await page.locator('button[data-action=pdf]').click();
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
