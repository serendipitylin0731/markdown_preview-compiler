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
async function crlfVisualHarness(page, initialSource) {
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  let source = initialSource;
  const eol = initialSource.includes('\r\n') ? '\r\n' : '\n';
  let version = 1, count = 0;
  await deliver(page, { type: 'document', source, version, settings: {}, exportSettings: {}, templates: [] });
  return {
    source: () => source,
    async sync() {
      try {
        await page.waitForFunction(n => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length > n, count, { timeout: 5000 });
      } catch (error) {
        const state = await page.evaluate(() => ({ status: document.getElementById('status')?.textContent,
          active: document.activeElement?.outerHTML.slice(0, 180), list: document.querySelector('#documentBody ul')?.outerHTML.slice(0, 500),
          edits: window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length }));
        throw new Error(`Visual edit did not sync: ${JSON.stringify(state)}`, { cause: error });
      }
      const edit = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').at(-1));
      count++;
      assert.equal(source.slice(edit.start, edit.end), edit.expected);
      source = source.slice(0, edit.start) + edit.replacement.replace(/\r?\n/g, eol) + source.slice(edit.end);
      version++;
      await deliver(page, { type: 'documentChanged', source, version });
      await deliver(page, { type: 'editAck', id: edit.id, source, version });
      return edit;
    }
  };
}
test('Enter and Shift Enter use the requested blank-line spacing for LF and CRLF', async () => {
  for (const eol of ['\n', '\r\n']) {
    for (const shortcut of ['Enter', 'Shift+Enter']) {
      const page = await browser.newPage();
      const host = await crlfVisualHarness(page, `前段${eol}${eol}后段${eol}`);
      await page.locator('#documentBody p').first().click();
      await page.keyboard.press('End');
      await page.keyboard.press(shortcut);
      if (shortcut === 'Shift+Enter') {
        await host.sync();
        assert.equal(host.source(), `前段  ${eol}${eol}后段${eol}`);
      } else {
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length), 0);
      }
      await page.keyboard.type('新段'); await host.sync();
      const separator = shortcut === 'Enter' ? `${eol}${eol}` : `  ${eol}`;
      assert.equal(host.source(), `前段${separator}新段${eol}${eol}后段${eol}`, `${JSON.stringify({ eol, shortcut })}`);
      await page.keyboard.type('续'); await host.sync();
      assert.equal(host.source(), `前段${separator}新段续${eol}${eol}后段${eol}`);
      await page.close();
    }
  }
});
test('Enter and Shift Enter keep exact spacing when splitting the middle of a line', async () => {
  for (const eol of ['\n', '\r\n']) {
    for (const shortcut of ['Enter', 'Shift+Enter']) {
      const page = await browser.newPage();
      const host = await crlfVisualHarness(page, `甲乙丙丁${eol}${eol}后段${eol}`);
      await placeParagraphCaret(page, '甲乙丙丁', 2);
      await page.keyboard.press(shortcut); await host.sync();
      await page.keyboard.type('新'); await host.sync();
      const separator = shortcut === 'Enter' ? `${eol}${eol}` : `  ${eol}`;
      assert.equal(host.source(), `甲乙${separator}新丙丁${eol}${eol}后段${eol}`, `${JSON.stringify({ eol, shortcut })}`);
      await page.close();
    }
  }
});
async function placeParagraphCaret(page, prefix, offset) {
  await page.evaluate(({ prefix, offset }) => {
    const paragraph = [...document.querySelectorAll('#documentBody p')].find(p => p.textContent?.startsWith(prefix));
    if (!paragraph?.firstChild) throw new Error(`Missing paragraph: ${prefix}`);
    const range = document.createRange();
    range.setStart(paragraph.firstChild, Math.min(offset, paragraph.firstChild.textContent.length));
    range.collapse(true);
    paragraph.closest('.block-content').focus();
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  }, { prefix, offset });
}
test('CRLF paragraph lines insert, merge, delete and retain the editing caret', async () => {
  const page = await browser.newPage();
  const host = await crlfVisualHarness(page, ['# 主标题', '', '## 背景', '', '甲乙丙丁。', '', '第二段。', '', '第三段。', ''].join('\r\n'));
  await page.locator('#documentBody p').filter({ hasText: '甲乙丙丁' }).click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('新行'); await host.sync();
  await page.keyboard.type('续'); await host.sync();
  assert.match(host.source(), /甲乙丙丁。\r\n\r\n新行续\r\n/);
  await page.locator('#documentBody p').filter({ hasText: '新行续' }).selectText();
  await page.keyboard.press('Backspace'); await host.sync();
  assert.doesNotMatch(host.source(), /新行续/);
  await page.keyboard.type('归'); await host.sync();
  assert.match(host.source(), /甲乙丙丁。归/);
  await page.keyboard.press('Backspace'); await host.sync();
  await placeParagraphCaret(page, '甲乙丙丁', 2);
  await page.keyboard.press('Enter'); await host.sync();
  await page.keyboard.type('插'); await host.sync();
  assert.match(host.source(), /甲乙\r\n\r\n插丙丁/);
  await placeParagraphCaret(page, '插丙丁', 0);
  await page.keyboard.press('Enter'); await host.sync();
  await page.keyboard.type('首'); await host.sync();
  assert.match(host.source(), /首插丙丁/);
  await placeParagraphCaret(page, '首插丙丁', 0);
  await page.keyboard.press('Backspace'); await host.sync();
  await page.keyboard.type('合'); await host.sync();
  assert.match(host.source(), /甲乙合首插丙丁/);
  await page.locator('#documentBody p').filter({ hasText: '甲乙合首插丙丁' }).click();
  await page.keyboard.press('End'); await page.keyboard.press('Delete'); await host.sync();
  await page.keyboard.type('尾'); await host.sync();
  assert.match(host.source(), /甲乙合首插丙丁。尾第二段。/);
  await page.locator('#documentBody h2').first().click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('副题'); await host.sync();
  assert.match(host.source(), /## 背景\r\n\r\n副题\r\n/);
  await page.locator('#documentBody p').filter({ hasText: '第三段' }).click();
  await page.keyboard.press('End'); await page.keyboard.insertText('粘贴甲\n粘贴乙'); await host.sync();
  assert.match(host.source(), /粘贴甲\r\n\r\n粘贴乙/);
  await page.waitForTimeout(350);
  assert.match(host.source(), /第三段/);
  await page.close();
});
test('CRLF list, code and aligned table edits preserve adjacent content and undo history', async () => {
  const page = await browser.newPage();
  const source = ['# 文档', '', '- 首项含 $n$', '- 次项', '- 末项', '', '后续段落。', '',
    '```text', 'A', 'B', '```', '', '| 甲 | 乙 |', '| :---: | ---: |', '| 1 | 2 |', '| 3 | 4 |', '', '末尾段落。', ''].join('\r\n');
  const host = await crlfVisualHarness(page, source);
  await page.locator('#documentBody li').first().click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await host.sync();
  await page.keyboard.type('新增项'); await host.sync();
  assert.match(host.source(), /- 新增项\r\n- 次项/);
  assert.match(host.source(), /\r\n\r\n后续段落。/);
  await page.locator('#documentBody li').filter({ hasText: '新增项' }).selectText();
  await page.keyboard.press('Backspace'); await host.sync();
  await page.locator('#documentBody li').nth(1).click();
  await page.keyboard.press('Backspace'); await host.sync();
  assert.doesNotMatch(host.source(), /新增项|\r\n-\r\n/);
  await page.locator('#documentBody [data-direct="code"]').click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('新代码'); await host.sync();
  assert.match(host.source(), /```text[\s\S]*新代码[\s\S]*```\r\n\r\n\| 甲/);
  await page.evaluate(() => {
    const code = document.querySelector('#documentBody [data-direct="code"]');
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const offset = node.textContent.indexOf('新代码');
      if (offset < 0) continue;
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 3);
      code.focus(); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); return;
    }
    throw new Error('Missing inserted code line');
  });
  await page.keyboard.press('Backspace'); await host.sync();
  assert.doesNotMatch(host.source(), /新代码/);
  const table = page.locator('#documentBody table').first();
  const rowCount = await table.locator('tr').count();
  await table.locator('td').first().click();
  await page.locator('button[data-action=row]').click(); await host.sync();
  assert.equal(await page.locator('#documentBody table tr').count(), rowCount + 1);
  assert.match(host.source(), /\| :---: \| ---: \|/);
  await page.keyboard.press('Control+z'); await host.sync();
  assert.equal(await page.locator('#documentBody table tr').count(), rowCount);
  await page.keyboard.press('Control+y'); await host.sync();
  assert.equal(await page.locator('#documentBody table tr').count(), rowCount + 1);
  await page.locator('#documentBody table td').first().click();
  await page.locator('button[data-action=column]').click(); await host.sync();
  assert.equal(await page.locator('#documentBody table th').count(), 3);
  await page.locator('#documentBody table td').last().click();
  await page.locator('button[data-action=deleteColumn]').click(); await host.sync();
  assert.equal(await page.locator('#documentBody table th').count(), 2);
  await page.locator('#documentBody table tbody tr').last().locator('td').first().click();
  await page.locator('button[data-action=deleteRow]').click(); await host.sync();
  assert.equal(await page.locator('#documentBody table tr').count(), rowCount);
  assert.match(host.source(), /\| :---: \| ---: \|/);
  assert.match(host.source(), /末尾段落。\r\n$/);
  await page.close();
});
test('CRLF nested lists and task checks keep their markers when edited', async () => {
  const page = await browser.newPage();
  const source = ['3. 父项', '   - 子项甲', '   - 子项乙', '4. 第二项', '', '- [ ] 待办', ''].join('\r\n');
  const host = await crlfVisualHarness(page, source);
  await page.locator('#documentBody li').filter({ hasText: '子项甲' }).last().click();
  await page.keyboard.press('End'); await page.keyboard.type('续'); await host.sync();
  assert.match(host.source(), /3\. 父项\r\n   - 子项甲续\r\n   - 子项乙\r\n4\. 第二项/);
  await page.locator('#documentBody input[type=checkbox]').check(); await host.sync();
  assert.match(host.source(), /- \[x\] 待办/);
  await page.close();
});
test('CRLF paragraph merge next to inline math keeps the formula intact', async () => {
  const page = await browser.newPage();
  const host = await crlfVisualHarness(page, '前文 $n$\r\n\r\n后文\r\n');
  await placeParagraphCaret(page, '后文', 0);
  await page.keyboard.press('Backspace'); await host.sync();
  await page.keyboard.type('续'); await host.sync();
  assert.match(host.source(), /前文 \$n\$续后文\r\n/);
  await page.close();
});
test('CRLF Markdown keeps syncing repeated and adjacent visual edits', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  let source = ['# 标题', '', '## 背景', '', '第一段内容。', '', '第二段内容。', '', '包含 $n$ 和 $a_i$ 的公式。', ''].join('\r\n');
  let version = 1;
  let editCount = 0;
  await deliver(page, { type: 'document', source, version, settings: {}, exportSettings: {}, templates: [] });
  for (const [index, letter] of [[2, 'A'], [2, 'B'], [3, 'C']]) {
    const block = page.locator('#documentBody .md-block').nth(index);
    await block.locator('.block-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type(letter);
    await page.waitForFunction(count => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').length > count, editCount, { timeout: 5000 });
    const edit = await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'edit').at(-1));
    editCount++;
    assert.equal(source.slice(edit.start, edit.end), edit.expected);
    source = source.slice(0, edit.start) + edit.replacement.replace(/\r?\n/g, '\r\n') + source.slice(edit.end);
    version++;
    await deliver(page, { type: 'documentChanged', source, version });
    await deliver(page, { type: 'editAck', id: edit.id, source, version });
    await page.waitForTimeout(350);
  }
  assert.match(source, /第一段内容。AB\r\n/);
  assert.match(source, /第二段内容。C\r\n/);
  await page.close();
});
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

test('PDF centers display math and keeps quotes light in a dark theme', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await page.addStyleTag({ content: ':root { --vscode-editor-background:#1f1f1f; --vscode-textBlockQuote-background:#333; } body blockquote { background:#333; }' });
  await deliver(page, { type: 'document', source: '行内公式 $E=mc^2$ 与文字。\n\n$$\n\\begin{aligned} a+b &= c+d \\\\ x+y &= z \\end{aligned}\n$$\n\n> 引用文字。\n',
    version: 1, settings: {}, exportSettings: { fontSize: 18, align: 'justify', firstLineIndent: 2 }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const layout = await page.evaluate(() => {
    const paper = document.querySelector('#printHost .print-page');
    const content = paper.querySelector('.print-content');
    const math = content.querySelector('.math-block');
    const inline = content.querySelector('.math-inline');
    const chinese = content.querySelector('p .print-chinese');
    const mathImage = math.querySelector('img.print-diagram');
    const inlineImage = inline.querySelector('img.print-diagram');
    const quote = content.querySelector('blockquote');
    const canvas = document.querySelector('#pdfPages canvas');
    const paperRect = paper.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const mathRect = math.getBoundingClientRect();
    const quoteRect = quote.getBoundingClientRect();
    const context = canvas.getContext('2d');
    const xScale = canvas.width / paperRect.width, yScale = canvas.height / paperRect.height;
    const pixel = (x, y) => [...context.getImageData(Math.floor((x - paperRect.left) * xScale),
      Math.floor((y - paperRect.top) * yScale), 1, 1).data].slice(0, 3);
    const ink = [];
    for (let x = mathRect.left; x < mathRect.right; x += 1) {
      for (let y = mathRect.top + 2; y < mathRect.bottom - 2; y += 2) {
        if (pixel(x, y).every(channel => channel < 120)) { ink.push(x); break; }
      }
    }
    return { quoteBackground: getComputedStyle(quote).backgroundColor,
      quotePixel: pixel(quoteRect.right - 10, quoteRect.top + 8),
      mathAlign: getComputedStyle(math).textAlign,
      mathImageSize: [mathImage?.naturalWidth, mathImage?.naturalHeight],
      inlineImageSize: [inlineImage?.naturalWidth, inlineImage?.naturalHeight],
      inlineBaselineGap: Math.abs(inline.getBoundingClientRect().bottom - chinese.getBoundingClientRect().bottom),
      mathCenter: (Math.min(...ink) + Math.max(...ink)) / 2,
      contentCenter: (contentRect.left + contentRect.right) / 2,
      inkCount: ink.length };
  });
  assert.equal(layout.quoteBackground, 'rgb(244, 247, 250)');
  assert.ok(layout.quotePixel.every(channel => channel > 230), `quote PDF pixel is too dark: ${layout.quotePixel}`);
  assert.equal(layout.mathAlign, 'center');
  assert.ok(layout.mathImageSize[0] > 80 && layout.mathImageSize[1] > 20);
  assert.ok(layout.inlineImageSize[0] > 30 && layout.inlineImageSize[1] > 10);
  assert.ok(layout.inlineBaselineGap < 3, `inline math shifted from text: ${layout.inlineBaselineGap}`);
  assert.ok(layout.inkCount > 10);
  assert.ok(Math.abs(layout.mathCenter - layout.contentCenter) < 10,
    `display math shifted from page center: ${JSON.stringify(layout)}`);
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

test('tester document PDF retains the full list and table', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const source = fs.readFileSync(path.resolve(__dirname, 'fixtures/tester.md'), 'utf8');
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const result = await page.evaluate(() => {
    const label = [...document.querySelectorAll('#printHost strong')].find(el => el.textContent?.includes('数据结构的物理结构'));
    const code = [...document.querySelectorAll('#printHost code')].find(el => el.textContent?.includes('存储结构'));
    const printPage = label?.closest('.print-page');
    const pageIndex = [...document.querySelectorAll('#printHost .print-page')].indexOf(printPage) + 1;
    const canvas = document.querySelector(`#pdfPages .pdf-page-slot[data-page="${pageIndex}"] canvas`);
    if (!label || !code || !printPage || !canvas) return null;
    const rect = label.getBoundingClientRect(), sheet = printPage.getBoundingClientRect();
    const x = Math.floor((rect.left - sheet.left) * canvas.width / sheet.width);
    const y = Math.floor((rect.top - sheet.top) * canvas.height / sheet.height);
    const width = Math.ceil(rect.width * canvas.width / sheet.width);
    const height = Math.ceil(rect.height * canvas.height / sheet.height);
    const pixels = canvas.getContext('2d').getImageData(x, y, width, height).data;
    let darkPixels = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) darkPixels++;
    return { darkPixels, codeBackground: getComputedStyle(code).backgroundColor,
      tableRows: document.querySelectorAll('#printHost table tr').length };
  });
  assert.ok(result, 'the affected list label and PDF canvas should be present');
  assert.ok(result.darkPixels > 200, `the label should remain visible in the PDF image: ${JSON.stringify(result)}`);
  assert.equal(result.codeBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(result.tableRows, 4);
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

test('pagination stays live with PDF auto update off and preserves earlier pages', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const prefix = '# 分页实时更新\n\n前面的页面。\n\n<!-- pagebreak -->\n\n';
  const source = prefix + '后面的内容。'.repeat(220) + '\n';
  await deliver(page, { type: 'document', source, version: 1,
    settings: { autoUpdate: false, editorFontFamily: 'Arial, sans-serif' }, exportSettings: { paper: 'a5' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  await page.evaluate(() => {
    window.__FIRST_PRINT_PAGE__ = document.querySelector('#printHost .print-page');
    window.__FIRST_PDF_CANVAS__ = document.querySelector('#pdfPages canvas');
  });
  const changed = prefix + '后面的内容。'.repeat(420) + '\n';
  await deliver(page, { type: 'documentChanged', source: changed, version: 2 });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('分页已更新'), { timeout: 30000 });
  const state = await page.evaluate(() => ({
    firstPageKept: window.__FIRST_PRINT_PAGE__ === document.querySelector('#printHost .print-page'),
    pdfCanvasKept: window.__FIRST_PDF_CANVAS__ === document.querySelector('#pdfPages canvas'),
    pageCount: document.querySelectorAll('#printHost .print-page').length,
    boundaries: window.__MDC_MESSAGES__.findLast(m => m.type === 'pageBoundaries')?.boundaries || [],
    codeFont: getComputedStyle(document.querySelector('#printHost .print-content')).fontFamily
  }));
  assert.equal(state.firstPageKept, true);
  assert.equal(state.pdfCanvasKept, true);
  assert.ok(state.pageCount >= 3);
  assert.ok(state.boundaries.some(item => item.type === 'automatic'));
  await page.locator('#autoUpdate').check();
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新') &&
    document.querySelectorAll('#pdfPages .pdf-page-slot').length >= 3, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__FIRST_PDF_CANVAS__ === document.querySelector('#pdfPages canvas')), true);
  await page.evaluate(() => {
    window.__FIRST_PDF_CANVAS__ = document.querySelector('#pdfPages canvas');
    window.__OLD_PDF_SLOTS__ = [...document.querySelectorAll('#pdfPages .pdf-page-slot')];
  });
  await deliver(page, { type: 'documentChanged', source: changed.replace('后面的内容。', '后面的新内容。'), version: 3 });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新') &&
    [...document.querySelectorAll('#pdfPages .pdf-page-slot')].some((slot, index) => index > 0 &&
      window.__OLD_PDF_SLOTS__[index] !== slot), { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__FIRST_PDF_CANVAS__ === document.querySelector('#pdfPages canvas')), true);
  await page.close();
});

test('an edit on page five hides its suffix and reveals each regenerated page', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const sections = Array.from({ length: 6 }, (_, i) => `## 第 ${i + 1} 页\n\n第 ${i + 1} 页正文。`);
  const source = sections.join('\n\n<!-- pagebreak -->\n\n') + '\n';
  await deliver(page, { type: 'document', source, version: 1, settings: { autoUpdate: true },
    exportSettings: { paper: 'a5', pageNumberFormat: 'fraction' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  assert.equal(await page.locator('#pdfPages .pdf-page-slot').count(), 6);
  assert.equal(await page.locator('#printHost .print-page-number').first().textContent(), '1');
  await page.evaluate(() => {
    window.__OLD_SLOTS__ = [...document.querySelectorAll('#pdfPages .pdf-page-slot')];
    window.__SLOT_COUNTS__ = [];
    window.__CAPTURE_COUNT__ = 0;
    new MutationObserver(() => window.__SLOT_COUNTS__.push(document.querySelectorAll('#pdfPages .pdf-page-slot').length))
      .observe(document.getElementById('pdfPages'), { childList: true });
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      window.__CAPTURE_COUNT__++;
      return original.apply(this, args);
    };
  });
  sections[4] = '## 第 5 页\n\n第五页已修改。';
  await deliver(page, { type: 'documentChanged', source: sections.join('\n\n<!-- pagebreak -->\n\n') + '\n', version: 2 });
  const immediate = await page.evaluate(() => ({
    count: document.querySelectorAll('#pdfPages .pdf-page-slot').length,
    kept: window.__OLD_SLOTS__.slice(0, 4).every((slot, i) => slot === document.querySelectorAll('#pdfPages .pdf-page-slot')[i])
  }));
  assert.deepEqual(immediate, { count: 4, kept: true });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新') &&
    document.querySelectorAll('#pdfPages .pdf-page-slot').length === 6, { timeout: 30000 });
  const final = await page.evaluate(() => ({ counts: window.__SLOT_COUNTS__, captures: window.__CAPTURE_COUNT__,
    kept: window.__OLD_SLOTS__.slice(0, 4).every((slot, i) => slot === document.querySelectorAll('#pdfPages .pdf-page-slot')[i]),
    replaced: window.__OLD_SLOTS__[4] !== document.querySelectorAll('#pdfPages .pdf-page-slot')[4] }));
  assert.ok(final.counts.includes(5) && final.counts.includes(6), JSON.stringify(final));
  assert.equal(final.captures, 2);
  assert.equal(final.kept, true);
  assert.equal(final.replaced, true);
  await page.evaluate(() => {
    window.__FIRST_SLOT_BEFORE_PAGE_COUNT_CHANGE__ = document.querySelector('#pdfPages .pdf-page-slot');
    window.__CAPTURE_COUNT__ = 0;
  });
  sections[4] += '\n\n<!-- pagebreak -->\n\n新增一页。';
  await deliver(page, { type: 'documentChanged', source: sections.join('\n\n<!-- pagebreak -->\n\n') + '\n', version: 3 });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新') &&
    document.querySelectorAll('#pdfPages .pdf-page-slot').length === 7, { timeout: 30000 });
  const renumbered = await page.evaluate(() => ({ captures: window.__CAPTURE_COUNT__,
    firstKept: window.__FIRST_SLOT_BEFORE_PAGE_COUNT_CHANGE__ === document.querySelector('#pdfPages .pdf-page-slot'),
    firstNumber: document.querySelector('#printHost .print-page-number')?.textContent }));
  assert.deepEqual(renumbered, { captures: 2, firstKept: true, firstNumber: '1' });
  await page.close();
});

test('editing page five inside one automatically split paragraph keeps earlier PDF pages', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const sentence = index => `第${String(index).padStart(4, '0')}段文字用于测试自动分页。`;
  const sentenceCount = 400;
  const source = '# 长段落\n\n' + Array.from({ length: sentenceCount }, (_, index) => sentence(index)).join('') + '\n';
  await deliver(page, { type: 'document', source, version: 1, settings: { autoUpdate: true },
    exportSettings: { paper: 'a5' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const targetIndex = await page.evaluate((count) => {
    const pages = [...document.querySelectorAll('#printHost .print-page')];
    const fragment = pages[4]?.querySelector('.print-fragment');
    if (!fragment) return -1;
    const clone = fragment.firstElementChild;
    const start = -parseFloat(clone.style.top);
    return Math.floor((start + fragment.getBoundingClientRect().height / 2) / clone.getBoundingClientRect().height * count);
  }, sentenceCount);
  assert.ok(targetIndex > 0 && targetIndex < sentenceCount);
  await page.evaluate(() => {
    window.__OLD_PDF_SLOTS__ = [...document.querySelectorAll('#pdfPages .pdf-page-slot')];
    window.__CAPTURE_COUNT__ = 0;
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      window.__CAPTURE_COUNT__++;
      return original.apply(this, args);
    };
  });
  const changed = source.replace(sentence(targetIndex), sentence(targetIndex) + '新增内容。'.repeat(90));
  await deliver(page, { type: 'documentChanged', source: changed, version: 2 });
  const immediate = await page.evaluate(() => ({
    count: document.querySelectorAll('#pdfPages .pdf-page-slot').length,
    prefixKept: window.__OLD_PDF_SLOTS__.slice(0, 4).every((slot, index) =>
      slot === document.querySelectorAll('#pdfPages .pdf-page-slot')[index])
  }));
  assert.deepEqual(immediate, { count: 4, prefixKept: true });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新') &&
    document.querySelectorAll('#pdfPages .pdf-page-slot').length > 4, { timeout: 30000 });
  const final = await page.evaluate(() => ({
    pages: document.querySelectorAll('#pdfPages .pdf-page-slot').length,
    captures: window.__CAPTURE_COUNT__,
    prefixKept: window.__OLD_PDF_SLOTS__.slice(0, 4).every((slot, index) =>
      slot === document.querySelectorAll('#pdfPages .pdf-page-slot')[index]),
    firstNumber: document.querySelector('#printHost .print-page-number')?.textContent
  }));
  assert.ok(final.pages > 5, JSON.stringify(final));
  assert.equal(final.captures, final.pages - 4, JSON.stringify(final));
  assert.equal(final.prefixKept, true);
  assert.equal(final.firstNumber, '1');
  await page.close();
});

test('manual PDF update regenerates only changed pages after live pagination', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const separator = '\n\n<!-- pagebreak -->\n\n';
  const source = ['第一页。', '第二页。', '第三页。'].join(separator) + '\n';
  await deliver(page, { type: 'document', source, version: 1, settings: { autoUpdate: false },
    exportSettings: { pageNumberFormat: 'number' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  await page.evaluate(() => {
    window.__FIRST_SLOT__ = document.querySelector('#pdfPages .pdf-page-slot');
    window.__CAPTURE_COUNT__ = 0;
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      window.__CAPTURE_COUNT__++;
      return original.apply(this, args);
    };
  });
  await deliver(page, { type: 'documentChanged', source: source.replace('第二页。', '第二页已修改。'), version: 2 });
  assert.equal(await page.locator('#pdfPages .pdf-page-slot').count(), 1);
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('分页已更新'), { timeout: 30000 });
  await page.locator('[data-action="refresh"]').click();
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => ({
    count: document.querySelectorAll('#pdfPages .pdf-page-slot').length,
    firstKept: window.__FIRST_SLOT__ === document.querySelector('#pdfPages .pdf-page-slot'),
    captures: window.__CAPTURE_COUNT__
  })), { count: 3, firstKept: true, captures: 2 });
  await page.close();
});

test('code blocks use a monospace font even with a proportional editor font', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '```js\nconst value = 1;\n```\n', version: 1,
    settings: { fontFamily: 'Arial, sans-serif', editorFontFamily: 'Arial, sans-serif' },
    exportSettings: { fontFamily: 'Arial, sans-serif' }, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const fonts = await page.evaluate(() => ({
    preview: getComputedStyle(document.querySelector('#documentBody pre code')).fontFamily,
    print: getComputedStyle(document.querySelector('#printHost pre code')).fontFamily
  }));
  assert.match(fonts.preview, /monospace/i);
  assert.match(fonts.print, /monospace/i);
  assert.doesNotMatch(fonts.print, /Arial/i);
  await page.close();
});

test('a file edit interrupts the PDF currently being generated', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 更新\n\n初始内容。\n', version: 1,
    settings: { autoUpdate: true }, exportSettings: {}, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  await page.evaluate(() => {
    window.__MDC_FINAL_EDIT_SENT__ = false;
    window.__MDC_PDF_UPDATES__ = 0;
    new MutationObserver(() => {
      if (document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新')) window.__MDC_PDF_UPDATES__++;
    }).observe(document.getElementById('pdfStatus'), { childList: true, characterData: true, subtree: true });
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (!window.__MDC_FINAL_EDIT_SENT__) {
        window.__MDC_FINAL_EDIT_SENT__ = true;
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'documentChanged', source: '# 更新\n\n最终内容。\n', version: 3
        } }));
      }
      return original.apply(this, args);
    };
  });
  await deliver(page, { type: 'documentChanged', source: '# 更新\n\n中间内容。\n', version: 2 });
  await page.waitForFunction(() => window.__MDC_FINAL_EDIT_SENT__ &&
    document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新') &&
    document.querySelector('#printHost .print-content')?.textContent?.includes('最终内容'), { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__MDC_PDF_UPDATES__), 1);
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
  await page.addStyleTag({ content: ':root { --vscode-editor-background:#1f1f1f; --vscode-foreground:#ddd; }' });
  const source = '# 技术文档\n\n行内 $E=mc^2$。脚注[^n]\n\n$$\na+b=c\n$$\n\n```js\nconst a = 1;\n```\n\n```mermaid\nflowchart LR\n  A[编辑 Markdown] --> B[导出 PDF]\n```\n\n[^n]: 示例脚注\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  assert.ok(await page.locator('#documentBody .katex').count() >= 2);
  assert.ok(await page.locator('#documentBody .hljs').count() >= 1);
  assert.ok(await page.locator('#documentBody .footnotes').count() >= 1);
  await page.waitForFunction(() => document.querySelector('#documentBody .mermaid-source svg'), { timeout: 10000 });
  assert.ok(await page.locator('#documentBody .mermaid-source svg path').count() > 0);
  const mermaid = await page.evaluate(() => {
    const diagram = document.querySelector('#documentBody .mermaid-source');
    return { labels: [...diagram.querySelectorAll('.nodes text')].map(el => el.textContent).join(' '),
      dark: diagram.classList.contains('mermaid-dark'),
      arrow: getComputedStyle(diagram.querySelector('.edgePaths path')).stroke };
  });
  assert.match(mermaid.labels, /编辑 Markdown/);
  assert.match(mermaid.labels, /导出 PDF/);
  assert.equal(mermaid.dark, true);
  assert.equal(mermaid.arrow, 'rgb(190, 205, 227)');
  assert.deepEqual(errors, []);
  await page.close();
});

test('branch cases with operatorname render in both preview and PDF', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__?.some(m => m.type === 'ready'));
  const formula = String.raw`$$
\operatorname{branch}(u,v,w)=
\begin{cases}
(v,w),&v=n\text{ 或 }in[v]=2,\\
(stop[v],w+r[v]),&\text{否则}.
\end{cases}
$$`;
  await deliver(page, { type: 'document', source: formula, version: 1,
    settings: {}, exportSettings: {}, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const rendering = await page.evaluate(() => ({
    preview: !!document.querySelector('#documentBody .math-block .katex'),
    print: !!document.querySelector('#printHost .math-block .print-diagram'),
    printHeight: document.querySelector('#printHost .math-block .print-diagram')?.getBoundingClientRect().height || 0,
    chinese: document.querySelector('#documentBody .math-block')?.textContent || ''
  }));
  assert.equal(rendering.preview, true);
  assert.equal(rendering.print, true);
  assert.ok(rendering.printHeight > 40, `cases formula was flattened to an error: ${rendering.printHeight}px`);
  assert.match(rendering.chinese, /否则/);
  await page.close();
});

test('PDF preserves the complete sum formula and Mermaid labels from the demo document', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = fs.readFileSync(path.resolve(__dirname, '../examples/demo.md'), 'utf8');
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.waitForFunction(() => document.getElementById('pdfStatus')?.textContent?.includes('PDF 已更新'), { timeout: 30000 });
  const ink = await page.evaluate(() => {
    const countInk = (image, xStart, xEnd, yStart, yEnd) => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let y = yStart; y < yEnd; y++) for (let x = xStart; x < xEnd; x++) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset + 3] > 100 && data[offset] < 100 && data[offset + 1] < 100 && data[offset + 2] < 100) count++;
      }
      return count;
    };
    const math = document.querySelector('#printHost .math-block img.print-diagram');
    const diagram = document.querySelector('#printHost .mermaid-source img.print-diagram');
    const paper = math?.closest('.print-page');
    const preview = document.querySelector('#pdfPages canvas');
    const previewContext = preview?.getContext('2d');
    const paperRect = paper?.getBoundingClientRect();
    const diagramRect = diagram?.getBoundingClientRect();
    let previewLabels = 0;
    if (previewContext && paperRect && diagramRect) {
      const scaleX = preview.width / paperRect.width, scaleY = preview.height / paperRect.height;
      const x1 = Math.floor((diagramRect.left - paperRect.left + diagramRect.width * .06) * scaleX);
      const x2 = Math.floor((diagramRect.left - paperRect.left + diagramRect.width * .28) * scaleX);
      const y1 = Math.floor((diagramRect.top - paperRect.top + diagramRect.height * .35) * scaleY);
      const y2 = Math.floor((diagramRect.top - paperRect.top + diagramRect.height * .65) * scaleY);
      const pixels = previewContext.getImageData(x1, y1, x2 - x1, y2 - y1).data;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) previewLabels++;
    }
    return { math: math && {
      top: countInk(math, 0, math.naturalWidth, 0, Math.floor(math.naturalHeight / 3)),
      bottom: countInk(math, 0, math.naturalWidth, Math.floor(math.naturalHeight * 2 / 3), math.naturalHeight),
      total: countInk(math, 0, math.naturalWidth, 0, math.naturalHeight) },
      labels: diagram && countInk(diagram, 20, Math.floor(diagram.naturalWidth / 3),
        Math.floor(diagram.naturalHeight / 3), Math.floor(diagram.naturalHeight * 2 / 3)), previewLabels };
  });
  assert.ok(ink.math?.top > 100 && ink.math?.bottom > 100 && ink.math?.total > 2500, JSON.stringify(ink));
  assert.ok(ink.labels > 100, JSON.stringify(ink));
  assert.ok(ink.previewLabels > 30, JSON.stringify(ink));
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
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'pdf').length), 1);
  assert.equal(await page.locator('#pdfPane').isVisible(), false);
  assert.equal(await page.locator('button[data-action=settings]').isVisible(), false);
  await page.close();
  const pdf = await browser.newPage();
  await pdf.goto(base + '/?mode=pdf');
  assert.equal(await pdf.locator('#pdfPane').isVisible(), true);
  assert.equal(await pdf.locator('#documentPane').isVisible(), false);
  assert.equal(await pdf.locator('button[data-action=settings]').isVisible(), true);
  assert.equal(await pdf.locator('button[data-action=export]').isVisible(), true);
  await pdf.close();
});

test('switching from visual editing to PDF waits for the last source edit', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=visual');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  const source = '原文。\n';
  await deliver(page, { type: 'document', source, version: 1, settings: {}, exportSettings: {}, templates: [] });
  await page.locator('#documentBody p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('新增');
  await page.locator('button[data-action=pdf]').click();
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'edit'));
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'pdf').length), 0);
  const edit = await page.evaluate(() => window.__MDC_MESSAGES__.find(m => m.type === 'edit'));
  const updated = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  assert.match(updated, /原文。新增/);
  await deliver(page, { type: 'documentChanged', source: updated, version: 2 });
  await deliver(page, { type: 'editAck', id: edit.id, source: updated, version: 2 });
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'pdf'));
  assert.equal(await page.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'pdf').length), 1);
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
  await page.goto(base + '/?mode=pdf');
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

test('PDF controls show marker state without an editing pane', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 内容\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await page.locator('button[data-action=breakMarkers]').click();
  assert.equal(await page.locator('button[data-action=breakMarkers]').textContent(), '显示分页标记');
  assert.equal(await page.locator('button[data-action=breakMarkers]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#documentPane').isVisible(), false);
  assert.equal(await page.locator('button[data-action=fullPdf]').count(), 0);
  await page.close();
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
  await page.goto(base + '/?mode=pdf');
  await page.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(page, { type: 'document', source: '# 交大报告\n\n正文\n', version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
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

test('a template chosen in PDF preview can be applied to a visual selection', async () => {
  const source = '第一段。\n\n第二段。\n';
  const pdf = await browser.newPage();
  await pdf.goto(base + '/?mode=pdf');
  await pdf.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(pdf, { type: 'document', source, version: 1, settings: { autoUpdate: false }, exportSettings: {}, templates: [] });
  await pdf.locator('button[data-action=settings]').click();
  assert.equal(await pdf.locator('.setting-grid > :first-child strong').textContent(), '模板');
  await pdf.locator('input[name=template][value=academic]').check();
  await pdf.locator('button[data-action=saveSettings]').click();
  const chosen = await pdf.evaluate(() => window.__MDC_MESSAGES__.findLast(m => m.type === 'saveSettings')?.value);
  assert.equal(chosen.pendingTemplateBrush, 'academic');
  await pdf.close();

  const visual = await browser.newPage();
  await visual.goto(base + '/?mode=visual');
  await visual.waitForFunction(() => window.__MDC_MESSAGES__.some(m => m.type === 'ready'));
  await deliver(visual, { type: 'document', source, version: 1, settings: { autoUpdate: false }, exportSettings: chosen, templates: [] });
  await visual.locator('#documentBody p').first().selectText();
  await visual.locator('#documentBody p').first().dispatchEvent('mouseup');
  await visual.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveSettings').some(m => m.value.templateRanges?.length));
  const saved = await visual.evaluate(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveSettings').findLast(m => m.value.templateRanges?.length).value);
  assert.deepEqual(saved.templateRanges, [{ start: 0, end: 0, id: 'academic' }]);
  assert.equal(saved.baseTemplate, 'simple');
  assert.equal(saved.pendingTemplateBrush, '');
  await deliver(visual, { type: 'documentChanged', source: '前言。\n\n第一段。\n\n第二段。\n', version: 2 });
  await visual.waitForFunction(() => window.__MDC_MESSAGES__.filter(m => m.type === 'saveSettings').some(m => m.value.templateRanges?.[0]?.start === 1));
  await visual.close();
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
