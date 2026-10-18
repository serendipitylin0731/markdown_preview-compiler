// @ts-nocheck
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import katex from 'katex';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import './style.css';

declare const acquireVsCodeApi: () => { postMessage(value: unknown): void; getState(): any; setState(value: any): void };
const vscode = acquireVsCodeApi();
const boot = (window as any).__MDC_BOOT__;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

const md = new MarkdownIt({
  html: true, linkify: true, typographer: true,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try { return `<pre class="hljs"><code>${hljs.highlight(code, { language }).value}</code></pre>`; } catch {}
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  }
}).use(anchor, { permalink: false }).use(footnote).use(taskLists, { enabled: false, label: true, labelAfter: true });

md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
  const end = state.src.indexOf('$', state.pos + 1);
  if (end < 0 || end === state.pos + 1 || state.src[end - 1] === '\\') return false;
  if (!silent) { const token = state.push('math_inline', 'span', 0); token.content = state.src.slice(state.pos + 1, end); }
  state.pos = end + 1; return true;
});
md.renderer.rules.math_inline = (tokens, i) => {
  try { return `<span class="math-inline" data-tex="${esc(tokens[i].content)}">${katex.renderToString(tokens[i].content, { throwOnError: false, trust: false, output: 'html' })}</span>`; }
  catch { return '<span class="render-error">公式无法渲染</span>'; }
};
md.block.ruler.before('fence', 'math_block', (state, start, end, silent) => {
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (!line.startsWith('$$')) return false;
  let close = start;
  const inline = line.slice(2);
  if (inline.endsWith('$$') && inline.length > 2) close = start;
  else {
    for (let i = start + 1; i < end; i++) {
      const test = state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]);
      if (test.trim().endsWith('$$')) { close = i; break; }
    }
    if (close === start) return false;
  }
  if (!silent) {
    const token = state.push('math_block', 'div', 0);
    token.content = state.getLines(start, close + 1, 0, false).replace(/^\s*\$\$/, '').replace(/\$\$\s*$/, '');
    token.map = [start, close + 1];
  }
  state.line = close + 1; return true;
});
md.renderer.rules.math_block = (tokens, i) => {
  try { return `<div class="math-block">${katex.renderToString(tokens[i].content, { displayMode: true, throwOnError: false, trust: false, output: 'html' })}</div>`; }
  catch { return '<div class="render-error">公式无法渲染</div>'; }
};
const originalFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, i, options, env, self) => {
  if (tokens[i].info.trim().toLowerCase() === 'mermaid') {
    return `<div class="mermaid-source" data-graph="${encodeURIComponent(tokens[i].content)}">正在渲染图表…</div>`;
  }
  return originalFence!(tokens, i, options, env, self);
};
md.renderer.rules.html_block = (tokens, i) => {
  if (/^\s*<!--\s*pagebreak\s*-->\s*$/i.test(tokens[i].content))
    return '<div class="manual-break" aria-label="手动分页">手动分页</div>';
  return tokens[i].content;
};
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
turndown.use(gfm);
turndown.addRule('math', {
  filter: node => node.nodeType === 1 && (node.classList?.contains('math-inline') || node.classList?.contains('katex')),
  replacement: (_content, node) => {
    if (node.classList?.contains('math-inline')) return `$${node.getAttribute('data-tex') || ''}$`;
    const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
    return annotation ? `$${annotation.textContent}$` : node.textContent || '';
  }
});

type Block = { start: number; end: number; raw: string; html: string; editable: boolean; line: number };
let source = '';
let version = 0;
let mode = boot.mode;
let settings: any = {};
let exportSettings: any = {
  paper: 'a4', orientation: 'portrait', marginTop: 24, marginRight: 22, marginBottom: 24, marginLeft: 22,
  fontSize: 11, lineHeight: 1.5, paragraphGap: 8, template: 'simple', cover: false, toc: false,
  header: '', footer: '', pageNumbers: true, firstLineIndent: 0, align: 'left',
  fontFamily: '', titleFontFamily: '', headingScale: 1,
  headingGap: 1, pageNumberFormat: 'fraction',
  codeBackground: '#f4f6f8', tableHeaderBackground: '#eef2f6', tableBorderColor: '#aab4bf',
  coverSubtitle: '', coverAuthor: '', coverDate: true, coverDateText: '',
  coverPositions: { title: [50, 36], subtitle: [50, 47], author: [50, 73], date: [50, 81] }
};
function normalizeExportSettings() {
  const ranges: any = {
    marginTop: [0, 60], marginRight: [0, 60], marginBottom: [18, 60], marginLeft: [0, 60],
    fontSize: [6, 36], lineHeight: [1, 3], paragraphGap: [0, 50],
    firstLineIndent: [0, 10], headingScale: [0.5, 3], headingGap: [0.2, 3]
  };
  for (const [key, [min, max]] of Object.entries(ranges) as any) {
    const value = Number(exportSettings[key]);
    exportSettings[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
  }
}
let templates: any[] = [];
let templateImportDraft: { name: string; slots: Record<string, { name: string; url: string }> } | null = null;
let blocks: Block[] = [];
let pendingEdit: any = null;
let editTimer: number | undefined;
let scheduledBlock: HTMLElement | null = null;
let composingBlock: HTMLElement | null = null;
let saveQueued = false;
let pdfTimer: number | undefined;
let pdfBytes: Uint8Array | null = null;
let pdfPreviewImages: string[] = [];
let pdfPreviewSize: [number, number] = [210, 297];
let pdfObserver: IntersectionObserver | null = null;
let pdfRenderToken = 0;
let pdfPage = 1;
let pdfScale = 1;
let pdfBusy = false;
let pdfQueued = false;
let pdfDirty = true;
const imageSession = Date.now().toString(36) + Math.random().toString(36).slice(2);
let imageRequestSerial = 0;
const pendingImageRequests = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void; timer: number }>();
const imageDataCache = new Map<string, Promise<string>>();
let autoExport = false;
let visualPdf = false;
let autoUpdate = true;
let showBreaks = true;
let pageBoundaries: Array<{ line: number; page: number; type: string }> = [];
let lastScrollLine = 0;
let suppressScrollUntil = 0;
let lastSentScrollLine = -1;
let marginDraft: any = null;
let coverDraft: Record<string, [number, number]> | null = null;
let fonts: any[] = [];
let fontsReady: Promise<void> = Promise.resolve();
let activeBlock = -1;
let editSerial = 0;
let savedRange: Range | null = null;
let savedTableCell: HTMLElement | null = null;
let editHistory: Array<{ before: string; after: string }> = [];
let redoHistory: Array<{ before: string; after: string }> = [];
let ownEdits = new Map<number, string>();
let historyDirection: 'undo' | 'redo' | null = null;
let queuedHistory: 'undo' | 'redo' | null = null;
let templateBrush: string | null = null;
const root = document.getElementById('app')!;

function esc(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
function safeHref(value: string) {
  const href = value.trim();
  return !!href && (/^(https?:|mailto:|#)/i.test(href) || (!/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('//')));
}
function post(type: string, extra: any = {}) { vscode.postMessage({ type, ...extra }); }
function toast(message: string, error = false) {
  const el = document.getElementById('status'); if (!el) return;
  el.textContent = message; el.classList.toggle('error', error);
}
function sourceOffsets(input: string) {
  const offsets = [0];
  for (let i = 0; i < input.length; i++) if (input[i] === '\n') offsets.push(i + 1);
  offsets.push(input.length);
  return offsets;
}
function parseBlocks(input: string): Block[] {
  const offsets = sourceOffsets(input);
  const env = {};
  const tokens = md.parse(input, env);
  const spans: Array<{ start: number; end: number; index: number }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.level !== 0 || !token.map) continue;
    const [start, end] = token.map;
    if (end <= start) continue;
    if (spans.some(span => start >= span.start && end <= span.end)) continue;
    spans.push({ start, end, index });
  }
  spans.sort((a, b) => a.start - b.start);
  const result: Block[] = [];
  for (let i = 0; i < spans.length; i++) {
    const { start: line, end: endLine, index } = spans[i];
    const start = offsets[line] ?? input.length;
    const end = offsets[endLine] ?? input.length;
    const raw = input.slice(start, end);
    let protectedBlock = /^\s*(?:`{3,}|~{3,}|\$\$|<!--|<[^!]|\[[^\]]+\]:)/.test(raw) || /<[^>]+>/.test(raw);
    const kind = /^\s*(`{3,}|~{3,})/.test(raw) && !/^\s*(`{3,}|~{3,})\s*mermaid\b/i.test(raw) ? 'code' : /^\s*\$\$/.test(raw) ? 'math' : '';
    if (kind) protectedBlock = false;
    const next = spans[i + 1]?.index ?? tokens.length;
    let html = md.renderer.render(tokens.slice(index, next), md.options, env);
    if (/^\s*(:::|!!!)\s*\w+/m.test(raw)) {
      protectedBlock = true;
      html = '<div class="render-warning">该扩展指令暂不支持可视化渲染，请使用源码编辑。</div>' + html;
    }
    if (html.includes('class="footnotes"')) protectedBlock = true;
    result.push({ start, end, raw, html: DOMPurify.sanitize(html), editable: !protectedBlock, line, kind });
  }
  if (!result.length && input.trim()) result.push({ start: 0, end: input.length, raw: input,
    html: DOMPurify.sanitize(md.render(input)), editable: false, line: 0 });
  if (!result.length && !input.trim()) result.push({ start: 0, end: input.length, raw: input,
    html: '<p><br></p>', editable: true, line: 0 });
  return result;
}
function resolvedImage(raw: string): Promise<string> {
  const cached = imageDataCache.get(raw);
  if (cached) return cached;
  const request = new Promise<string>((resolve, reject) => {
    const id = `${imageSession}-${++imageRequestSerial}`;
    const timer = window.setTimeout(() => {
      pendingImageRequests.delete(id);
      reject(new Error('图片读取超时'));
    }, 20000);
    pendingImageRequests.set(id, { resolve, reject, timer });
    post('resolveImage', { id, source: raw });
  });
  imageDataCache.set(raw, request);
  void request.catch(() => { if (imageDataCache.get(raw) === request) imageDataCache.delete(raw); });
  return request;
}
async function localizeImages(container: HTMLElement) {
  const images = container.matches('img') ? [container as HTMLImageElement] : [...container.querySelectorAll<HTMLImageElement>('img')];
  await Promise.all(images.map(async img => {
    const raw = img.dataset.originalSrc || img.getAttribute('src') || '';
    if (!raw) return;
    if (!/^(data:|blob:|vscode-)/i.test(raw)) img.dataset.originalSrc = raw;
    try {
      const data = /^(data:|blob:|vscode-)/i.test(raw) ? raw : await resolvedImage(raw);
      if (!img.isConnected) return;
      img.src = data;
      await img.decode();
      img.classList.remove('missing-image');
      delete img.dataset.renderError;
    } catch (error) {
      if (!img.isConnected) return;
      img.removeAttribute('src');
      img.classList.add('missing-image');
      img.dataset.renderError = `图片无法加载：${raw}（${error instanceof Error ? error.message : error}）`;
      toast(img.dataset.renderError, true);
    }
  }));
}
async function renderMermaid(container: HTMLElement) {
  for (const element of container.querySelectorAll<HTMLElement>('.mermaid-source')) {
    try {
      const graph = decodeURIComponent(element.dataset.graph || '');
      const id = 'mdc-' + Math.random().toString(36).slice(2);
      const result = await mermaid.render(id, graph);
      element.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    } catch (error) {
      element.textContent = `Mermaid 渲染失败：${error instanceof Error ? error.message : error}`;
      element.classList.add('render-error');
    }
  }
}
function blockMarkup(block: Block, index: number, editable: boolean) {
  const sourceButton = !block.editable && editable ? '<button class="edit-source" data-action="editSource" title="编辑这段 Markdown 源码">编辑源码</button>' : '';
  if (editable && block.kind === 'code') {
    const match = block.raw.match(/^\s*(`{3,}|~{3,})([^\n]*)\n?([\s\S]*?)\n?\s*\1\s*$/);
    return `<section class="md-block direct-editor" data-index="${index}" data-line="${block.line}"><div class="block-content markdown-body"><pre class="hljs"><code contenteditable="true" spellcheck="false" data-direct="code">${esc(match?.[3] || '')}</code></pre></div></section>`;
  }
  if (editable && block.kind === 'math') {
    const value = block.raw.replace(/^\s*\$\$\s*/, '').replace(/\s*\$\$\s*$/, '');
    return `<section class="md-block direct-editor" data-index="${index}" data-line="${block.line}"><div class="block-content markdown-body">${block.html}<textarea class="direct-math" data-direct="math" spellcheck="false" aria-label="直接编辑公式">${esc(value)}</textarea></div></section>`;
  }
  return `<section class="md-block ${block.editable ? '' : 'protected'}" data-index="${index}" data-line="${block.line}">
    ${sourceButton}<div class="block-content markdown-body" ${editable && block.editable ? 'contenteditable="true" spellcheck="true"' : ''}>${block.html}</div>
    </section>`;
}
function toolbar() {
  return `<header class="toolbar"><div class="toolbar-group modes">
    <button data-action="split" class="${mode === 'preview' ? 'selected' : ''}">分屏</button>
    <button data-action="visual" class="${mode === 'visual' ? 'selected' : ''}">预览编辑</button>
    <button data-action="pdf" class="${mode === 'pdf' || visualPdf ? 'selected' : ''}">PDF 预览</button>
  </div><div class="toolbar-group visual-tools" style="display:${mode === 'visual' ? 'flex' : 'none'}">
    <select id="blockType" aria-label="段落类型"><option value="p">正文</option>${[1,2,3,4,5,6].map(n => `<option value="h${n}">标题 ${n}</option>`).join('')}</select>
    <button data-action="bold" title="加粗 Ctrl+B"><b>B</b></button><button data-action="italic" title="斜体 Ctrl+I"><i>I</i></button>
    <button data-action="strike" title="删除线"><s>S</s></button><button data-action="link">链接</button>
    <button data-action="ul">列表</button><button data-action="ol">编号</button><button data-action="quote">引用</button>
    <button data-action="image">图片</button><button data-action="table">表格</button>
    <span id="tableTools" class="toolbar-group" hidden><button data-action="row">+行</button><button data-action="column">+列</button>
    <button data-action="deleteRow">−行</button><button data-action="deleteColumn">−列</button></span>
    <button data-action="inlineCode">行内代码</button><button data-action="code">代码块</button><button data-action="inlineMath">行内公式</button><button data-action="math">独立公式</button><button data-action="mermaid">图表</button>
    <button data-action="break">分页</button>
  </div><div class="toolbar-group push pdf-actions" ${mode === 'pdf' || visualPdf ? '' : 'hidden'}>
    <button data-action="settings">排版设置</button>
    <button data-action="export" class="primary">导出 PDF</button>
  </div></header>`;
}
function updatePdfActions() {
  const actions = root.querySelector<HTMLElement>('.pdf-actions');
  if (actions) actions.hidden = !(mode === 'pdf' || visualPdf);
  root.querySelector<HTMLButtonElement>('button[data-action="pdf"]')?.classList.toggle('selected', mode === 'pdf' || visualPdf);
}
function pdfControls() {
  return `<div class="pdf-controls"><button data-action="refresh">更新 PDF</button>
    <label><input type="checkbox" id="autoUpdate" ${autoUpdate ? 'checked' : ''}>自动更新</label>
    <button data-action="prev">‹</button><span id="pageInfo">0 / 0</span><button data-action="next">›</button>
    <button data-action="zoomOut">−</button><span id="zoomLabel">100%</span><button data-action="zoomIn">+</button>
    <button data-action="breakMarkers" aria-pressed="${showBreaks}">${showBreaks ? '隐藏分页标记' : '显示分页标记'}</button>
    ${mode === 'visual' ? '<button data-action="fullPdf" aria-pressed="false">展开 PDF</button>' : ''}</div><div id="pdfStatus" class="pdf-status"></div><div id="pdfPages" class="pdf-pages"></div>`;
}
function buildShell() {
  root.innerHTML = `${toolbar()}<div id="workspace" class="${mode} ${visualPdf ? 'with-pdf' : ''}">
    <div id="documentPane"><div class="document-scroll"><div id="documentBody"></div></div></div>
    <div id="pdfPane">${pdfControls()}</div></div>
    <div id="dialogBackdrop" class="dialog-backdrop hidden"><div id="dialog" class="dialog"></div></div>
    <div id="status" role="status"></div><div id="printHost" aria-hidden="true"></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('focusin', onFocus);
  root.addEventListener('dblclick', onDoubleClick);
  document.addEventListener('selectionchange', updateTableTools);
  root.querySelector('#documentBody')?.addEventListener('mouseup', applyTemplateToSelection);
  root.querySelector('#pdfPages')?.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setScale(pdfScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  root.querySelector('.document-scroll')?.addEventListener('scroll', onDocumentScroll, { passive: true });
  const documentPane = root.querySelector<HTMLElement>('.document-scroll');
  if (documentPane) new ResizeObserver(() => documentPane.style.setProperty('--preview-height', `${documentPane.clientHeight}px`)).observe(documentPane);
  const pdfPages = document.getElementById('pdfPages');
  pdfPages?.addEventListener('scroll', () => {
    const slots = [...pdfPages.querySelectorAll<HTMLElement>('.pdf-page-slot')];
    if (slots.length) {
      const top = pdfPages.getBoundingClientRect().top + 80;
      const nearest = slots.findIndex(slot => slot.getBoundingClientRect().bottom > top);
      if (nearest >= 0) { pdfPage = nearest + 1; updatePageInfo(); }
    }
  }, { passive: true });
}
function renderDocument(preserve = true) {
  const pane = document.querySelector<HTMLElement>('.document-scroll');
  const previous = preserve ? pane?.scrollTop || 0 : 0;
  blocks = parseBlocks(source);
  const body = document.getElementById('documentBody')!;
  body.innerHTML = blocks.map((block, i) => blockMarkup(block, i, mode === 'visual')).join('') || '<div class="empty">开始编写 Markdown…</div>';
  if (mode === 'visual') body.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => input.disabled = false);
  void localizeImages(body);
  void renderMermaid(body);
  if (pane) pane.scrollTop = previous;
  if (mode === 'preview' && lastScrollLine && settings.syncScroll) scrollToLine(lastScrollLine);
  if (mode === 'pdf') document.getElementById('documentPane')!.style.display = 'none';
  document.documentElement.style.setProperty('--editor-font', settings.fontFamily || 'system-ui, sans-serif');
  document.documentElement.style.setProperty('--editor-size', `${settings.fontSize || 16}px`);
  document.documentElement.style.setProperty('--editor-line', String(settings.lineHeight || 1.6));
  document.documentElement.style.setProperty('--editor-paragraph-gap', `${settings.paragraphGap ?? 10}px`);
  document.documentElement.style.setProperty('--editor-width', `${settings.maxWidth || 860}px`);
}
function scrollToLine(line: number) {
  const pane = document.querySelector<HTMLElement>('.document-scroll');
  if (!pane) return;
  const nodes = [...document.querySelectorAll<HTMLElement>('#documentBody .md-block')];
  const node = nodes.findLast(n => Number(n.dataset.line) <= line) || nodes[0];
  if (!node) return;
  const offset = node.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  const target = Math.max(0, Math.min(offset, pane.scrollHeight - pane.clientHeight));
  if (Math.abs(pane.scrollTop - target) < 2) return;
  suppressScrollUntil = Date.now() + 350;
  pane.scrollTop = target;
}
function onDocumentScroll() {
  if (mode !== 'preview' || !settings.syncScroll || Date.now() < suppressScrollUntil) return;
  const pane = document.querySelector<HTMLElement>('.document-scroll')!;
  const top = pane.getBoundingClientRect().top + 50;
  const nodes = [...document.querySelectorAll<HTMLElement>('#documentBody .md-block')];
  const atBottom = pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 2;
  const node = atBottom ? nodes.at(-1) : nodes.findLast(n => n.getBoundingClientRect().top <= top);
  const line = node ? Number(node.dataset.line) : -1;
  if (line >= 0 && line !== lastSentScrollLine) { lastSentScrollLine = line; post('scrollTo', { line }); }
}
function selectedBlockElement(): HTMLElement | null {
  const selection = window.getSelection();
  return (selection?.anchorNode?.nodeType === 1 ? selection.anchorNode as Element : selection?.anchorNode?.parentElement)?.closest('.md-block') as HTMLElement || null;
}
function onFocus(event: FocusEvent) {
  const block = (event.target as HTMLElement).closest('.md-block') as HTMLElement | null;
  if (block) {
    activeBlock = Number(block.dataset.index);
    const type = block.querySelector('.block-content > :first-child')?.tagName.toLowerCase() || 'p';
    const select = document.getElementById('blockType') as HTMLSelectElement;
    if (select) select.value = /^h[1-6]$/.test(type) ? type : 'p';
  }
  updateTableTools();
}
function onInput(event: Event) {
  const target = event.target as HTMLElement;
  if (target.id === 'templateImportName' && templateImportDraft) templateImportDraft.name = (target as HTMLInputElement).value;
  if (['set-coverSubtitle', 'set-coverAuthor', 'set-coverDateText'].includes(target.id)) updateCoverSheet();
  const block = target.closest('.md-block') as HTMLElement | null;
  if (block && target.closest('.block-content')) {
    const input = event as InputEvent;
    if (input.isComposing || input.inputType === 'insertCompositionText' || composingBlock === block) return;
    if (target.matches('.direct-inline-math')) {
      const wrapper = target.closest<HTMLElement>('.math-inline');
      if (wrapper) wrapper.dataset.tex = (target as HTMLInputElement).value;
    }
    if (target.matches('[data-direct="math"]')) {
      const preview = block.querySelector<HTMLElement>('.math-block');
      if (preview) preview.innerHTML = katex.renderToString((target as HTMLTextAreaElement).value, { displayMode: true, throwOnError: false, trust: false, output: 'html' });
    }
    if (!target.matches('[data-direct]')) renderTypedMarkdown(block, input);
    scheduleBlockSave(block);
  }
}
function onCompositionStart(event: CompositionEvent) {
  const block = (event.target as HTMLElement).closest('.md-block') as HTMLElement | null;
  if (!block || !(event.target as HTMLElement).closest('.block-content')) return;
  composingBlock = block;
  window.clearTimeout(editTimer);
  editTimer = undefined;
  scheduledBlock = block;
}
function onCompositionEnd(event: CompositionEvent) {
  const block = (event.target as HTMLElement).closest('.md-block') as HTMLElement | null;
  if (block !== composingBlock) return;
  composingBlock = null;
  // The final input event can follow compositionend, so let it update the DOM first.
  window.setTimeout(() => { if (block.isConnected && composingBlock !== block) scheduleBlockSave(block); }, 0);
}
function renderTypedMarkdown(block: HTMLElement, event: InputEvent) {
  if (event.isComposing || ![' ', '*', '_', '~', '`', '$', '\n', ')', ']'].includes(event.data || '') && event.inputType !== 'insertParagraph') return;
  const content = block.querySelector<HTMLElement>('.block-content');
  const only = content?.firstElementChild;
  const plainParagraph = only && only === content.lastElementChild && only.tagName === 'P' &&
    [...only.childNodes].every(node => node.nodeType !== 1 || (node as Element).tagName === 'BR');
  const plainContent = content && !content.children.length;
  if (!plainParagraph && !plainContent) return;
  const raw = ((plainParagraph ? only : content)?.textContent || '').replace(/\u00a0/g, ' ');
  if (raw.includes('**') && !/\*\*[^*]+\*\*/.test(raw)) return;
  if (raw.includes('~~') && !/~~[^~]+~~/.test(raw)) return;
  if (!/^(?:#{1,6} |[-*+] |\d+\. |>|```|\$\$)|(?:\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\$[^$]+\$|\[[^\]]+\]\([^)]+\))/.test(raw)) return;
  const rendered = DOMPurify.sanitize(md.render(raw));
  if (!rendered || rendered === content.innerHTML) return;
  content.innerHTML = rendered;
  const selection = window.getSelection();
  const range = document.createRange();
  const caretTarget = content.querySelector('li:last-child, h1:last-child, h2:last-child, h3:last-child, h4:last-child, h5:last-child, h6:last-child, p:last-child') || content.lastElementChild || content;
  range.selectNodeContents(caretTarget); range.collapse(false);
  selection?.removeAllRanges(); selection?.addRange(range);
}
function updateTableTools() {
  const cell = (window.getSelection()?.anchorNode?.nodeType === 1 ? window.getSelection()?.anchorNode as Element : window.getSelection()?.anchorNode?.parentElement)?.closest?.('#documentBody .block-content td, #documentBody .block-content th') as HTMLElement | null;
  savedTableCell = mode === 'visual' ? cell : null;
  const tools = document.getElementById('tableTools');
  if (tools) tools.hidden = !savedTableCell;
}
function applyTemplateToSelection() {
  if (!templateBrush || mode === 'pdf') return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const elementFor = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest?.('#documentBody .md-block') as HTMLElement | null;
  const first = elementFor(range.startContainer), last = elementFor(range.endContainer);
  if (!first || !last) return;
  const start = Math.min(Number(first.dataset.index), Number(last.dataset.index));
  const end = Math.max(Number(first.dataset.index), Number(last.dataset.index));
  exportSettings.templateRanges = [{ start, end, id: templateBrush }];
  templateBrush = null;
  pdfDirty = true; post('saveSettings', { value: exportSettings }); schedulePdf();
  toast(`模板已应用到第 ${start + 1} 至 ${end + 1} 段`);
}
function onDoubleClick(event: MouseEvent) {
  if (mode !== 'visual') return;
  const link = (event.target as HTMLElement).closest('#documentBody a[href]') as HTMLAnchorElement | null;
  if (link) { event.preventDefault(); editLink(link); }
  const math = (event.target as HTMLElement).closest('#documentBody .math-inline') as HTMLElement | null;
  if (math && !math.querySelector('input')) {
    event.preventDefault();
    const input = document.createElement('input');
    input.className = 'direct-inline-math'; input.setAttribute('aria-label', '直接编辑行内公式');
    input.value = math.dataset.tex || '';
    math.replaceChildren(input); input.focus(); input.select();
    input.addEventListener('blur', () => {
      math.dataset.tex = input.value;
      math.innerHTML = DOMPurify.sanitize(katex.renderToString(input.value, { throwOnError: false, trust: false, output: 'html' }));
      const block = math.closest('.md-block') as HTMLElement | null;
      if (block) scheduleBlockSave(block);
    }, { once: true });
  }
}
function editLink(link: HTMLAnchorElement) {
  showDialog('编辑链接', '<label>文字<input id="linkText"></label><label>地址<input id="linkUrl"></label><div class="dialog-actions"><button data-action="cancelDialog">取消</button><button data-action="removeLink">删除链接</button><button data-action="updateLink" class="primary">保存</button></div>', { link });
  (document.getElementById('linkText') as HTMLInputElement).value = link.textContent || '';
  (document.getElementById('linkUrl') as HTMLInputElement).value = link.getAttribute('href') || '';
}
function onKeydown(event: KeyboardEvent) {
  if (mode === 'visual' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (editTimer) { window.clearTimeout(editTimer); editTimer = undefined; const block = selectedBlockElement(); if (block) saveBlock(block); }
    if (pendingEdit) { queuedHistory = event.shiftKey ? 'redo' : 'undo'; return; }
    changeHistory(event.shiftKey ? 'redo' : 'undo'); return;
  }
  if (mode === 'visual' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault(); changeHistory('redo'); return;
  }
  if ((event.ctrlKey || event.metaKey) && ['b', 'i'].includes(event.key.toLowerCase()) && mode === 'visual') {
    event.preventDefault(); document.execCommand(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
    const block = selectedBlockElement(); if (block) scheduleBlockSave(block);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); saveQueued = true; toast('正在保存 Markdown…'); flushQueuedSave(); return;
  }
  if (event.key === 'Tab' && mode === 'visual') {
    const block = selectedBlockElement();
    if (block?.querySelector('li')) {
      event.preventDefault(); document.execCommand(event.shiftKey ? 'outdent' : 'indent'); scheduleBlockSave(block);
    }
  }
  if ((event.key === 'Backspace' || event.key === 'Delete') && mode === 'visual' && !event.isComposing) {
    const block = selectedBlockElement();
    const content = block?.querySelector<HTMLElement>('.block-content');
    const selection = window.getSelection();
    if (!content || !selection?.isCollapsed || block?.classList.contains('direct-editor')) return;
    if (!content.textContent?.trim() && !content.querySelector('img, table, input, code, pre, svg, iframe')) {
      event.preventDefault();
      removeBlock(block!);
      return;
    }
    if (event.key !== 'Backspace') return;
    if (content.children.length > 1 || (content.children.length === 1 && !/^(P|H[1-6])$/.test(content.firstElementChild?.tagName || ''))) return;
    const range = selection.getRangeAt(0).cloneRange();
    const before = range.cloneRange(); before.selectNodeContents(content); before.setEnd(range.startContainer, range.startOffset);
    if (before.toString().length) return;
    const index = Number(block?.dataset.index);
    const current = blocks[index], previous = blocks[index - 1];
    if (!current || !previous) return;
    event.preventDefault();
    window.clearTimeout(editTimer); editTimer = undefined;
    const empty = !content.textContent?.trim();
    const start = empty ? previous.end : Math.max(previous.start, previous.end - 1);
    const end = empty ? current.end : current.start;
    submitEdit(start, end, source.slice(start, end), '');
  }
}
function removeBlock(element: HTMLElement) {
  if (pendingEdit || !source) return;
  window.clearTimeout(editTimer); editTimer = undefined;
  if (scheduledBlock === element) scheduledBlock = null;
  const index = Number(element.dataset.index);
  const current = blocks[index];
  if (!current?.editable) return;
  const start = index ? blocks[index - 1].end : 0;
  const end = index ? current.end : blocks[index + 1]?.start ?? source.length;
  const id = ++editSerial;
  pendingEdit = { id, index, element, replacement: '', remove: true,
    nextSource: source.slice(0, start) + source.slice(end) };
  submitEdit(start, end, source.slice(start, end), '', id);
  toast('正在删除 Markdown 段落…');
}
function scheduleBlockSave(element: HTMLElement) {
  window.clearTimeout(editTimer);
  scheduledBlock = element;
  editTimer = window.setTimeout(() => saveBlock(element), 120);
}
function serializeBlock(element: HTMLElement, original: Block) {
  if (original.kind === 'code') {
    const opener = original.raw.match(/^\s*(`{3,}|~{3,})[^\n]*/)?.[0] || '```text';
    const fence = opener.trimStart().match(/^(`{3,}|~{3,})/)?.[0] || '```';
    return `${opener}\n${element.querySelector('[data-direct="code"]')?.textContent || ''}\n${fence}${original.raw.endsWith('\n') ? '\n' : ''}`;
  }
  if (original.kind === 'math') return `$$\n${(element.querySelector('[data-direct="math"]') as HTMLTextAreaElement)?.value || ''}\n$$${original.raw.endsWith('\n') ? '\n' : ''}`;
  const copy = element.querySelector<HTMLElement>('.block-content')!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll<HTMLImageElement>('img[data-original-src]').forEach(img => {
    img.setAttribute('src', img.dataset.originalSrc || '');
    img.removeAttribute('data-original-src');
  });
  copy.querySelectorAll('input[type=checkbox]').forEach((checkbox: HTMLInputElement) => {
    const li = checkbox.closest('li');
    if (li) li.dataset.checked = checkbox.checked ? 'true' : 'false';
  });
  let markdown = turndown.turndown(copy.innerHTML).trimEnd();
  if (/^\s*[-*+] \[[ xX]\]/m.test(original.raw)) {
    const checked = [...element.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    let i = 0;
    markdown = markdown.replace(/^(\s*[-*+]\s+)\[[ xX]\]/gm, (_match, prefix) => `${prefix}[${checked[i++]?.checked ? 'x' : ' '}]`);
  }
  return markdown + (original.raw.endsWith('\n') ? '\n' : '');
}
function saveBlock(element: HTMLElement) {
  if (composingBlock === element) { scheduledBlock = element; return; }
  if (pendingEdit) { scheduledBlock = element; editTimer = window.setTimeout(() => saveBlock(element), 80); return; }
  editTimer = undefined;
  if (scheduledBlock === element) scheduledBlock = null;
  if (!element.isConnected) return;
  const index = Number(element.dataset.index);
  const original = blocks[index];
  if (!original || !original.editable) return;
  const content = element.querySelector<HTMLElement>('.block-content');
  if (content && !content.textContent?.trim() && !content.querySelector('img, table, input, code, pre, svg, iframe')) {
    removeBlock(element);
    return;
  }
  const replacement = serializeBlock(element, original);
  if (replacement === original.raw) { if (saveQueued) flushQueuedSave(); return; }
  pendingEdit = { id: ++editSerial, index, element, replacement, snapshot: element.innerHTML,
    nextSource: source.slice(0, original.start) + replacement + source.slice(original.end) };
  submitEdit(original.start, original.end, original.raw, replacement, pendingEdit.id);
  toast('正在同步 Markdown…');
}
function flushQueuedSave() {
  if (!saveQueued || pendingEdit || ownEdits.size || composingBlock) return;
  if (scheduledBlock) {
    window.clearTimeout(editTimer); editTimer = undefined;
    const block = scheduledBlock;
    scheduledBlock = null;
    saveBlock(block);
    if (pendingEdit || ownEdits.size) return;
  }
  saveQueued = false;
  post('saveDocument');
}
function submitEdit(start: number, end: number, expected: string, replacement: string, id = ++editSerial) {
  ownEdits.set(id, source);
  post('edit', { id, start, end, expected, replacement });
}
function changeHistory(direction: 'undo' | 'redo') {
  const stack = direction === 'undo' ? editHistory : redoHistory;
  const entry = stack.at(-1);
  if (!entry || pendingEdit) return;
  const expected = direction === 'undo' ? entry.after : entry.before;
  const replacement = direction === 'undo' ? entry.before : entry.after;
  if (source !== expected) { toast('文档已在其他位置修改，无法继续撤销', true); return; }
  stack.pop();
  (direction === 'undo' ? redoHistory : editHistory).push(entry);
  historyDirection = direction;
  submitEdit(0, source.length, source, replacement);
}
function rebaseTemplateRanges(previous: string, next: string) {
  const ranges = exportSettings.templateRanges as Array<{ start: number; end: number; id: string }> | undefined;
  if (!ranges?.length || previous === next) return;
  const oldBlocks = blocks;
  const newBlocks = parseBlocks(next);
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const oldChangeEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  const mapOffset = (offset: number) => offset < prefix ? offset : offset >= oldChangeEnd ? offset + delta : prefix;
  const blockAt = (offset: number) => {
    const exact = newBlocks.findIndex(block => offset >= block.start && offset < block.end);
    return exact >= 0 ? exact : Math.max(0, newBlocks.findLastIndex(block => block.start <= offset));
  };
  const updated = ranges.map(range => {
    const first = oldBlocks[range.start], last = oldBlocks[range.end];
    if (!first || !last) return null;
    const start = blockAt(mapOffset(first.start));
    const end = blockAt(mapOffset(Math.max(last.start, last.end - 1)));
    return { start: Math.min(start, end), end: Math.max(start, end), id: range.id };
  }).filter(Boolean);
  if (JSON.stringify(updated) !== JSON.stringify(ranges)) {
    exportSettings.templateRanges = updated;
    post('saveSettings', { value: exportSettings });
  }
}
function applySource(newSource: string, newVersion: number, own = false) {
  if (newSource === source) { version = newVersion; return; }
  rebaseTemplateRanges(source, newSource);
  source = newSource; version = newVersion; pdfDirty = true;
  if (own && pendingEdit?.remove) pendingEdit = null;
  if (own && pendingEdit?.element?.isConnected) {
    const nextBlocks = parseBlocks(source);
    const current = pendingEdit.element;
    const index = pendingEdit.index;
    const fresh = nextBlocks[index];
    if (nextBlocks.length === blocks.length && fresh?.start === blocks[index]?.start) {
      blocks = nextBlocks;
      document.querySelectorAll<HTMLElement>('#documentBody .md-block').forEach((element, i) => {
        if (blocks[i]) element.dataset.line = String(blocks[i].line);
      });
      pendingEdit = null;
      if (mode === 'visual' && visualPdf && autoUpdate) schedulePdf();
      return;
    }
    const caret = captureBlockCaret(current);
    window.clearTimeout(editTimer); editTimer = undefined;
    if (scheduledBlock === current) scheduledBlock = null;
    pendingEdit = null;
    renderDocument();
    restoreBlockCaret(caret, index);
    if ((mode === 'pdf' || visualPdf) && autoUpdate) schedulePdf();
    return;
  }
  if (document.activeElement?.closest?.('.md-block') && pendingEdit) {
    window.setTimeout(() => applySource(newSource, newVersion), 300);
    return;
  }
  pendingEdit = null;
  renderDocument();
  if ((mode === 'pdf' || visualPdf) && autoUpdate) schedulePdf();
}
function captureBlockCaret(block: HTMLElement) {
  const selection = window.getSelection();
  const content = block.querySelector<HTMLElement>('.block-content');
  if (!content || !selection?.rangeCount || !content.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  let child: Node | null = range.startContainer;
  while (child?.parentNode !== content) child = child?.parentNode || null;
  if (!child) return null;
  const offset = document.createRange();
  offset.selectNodeContents(child);
  offset.setEnd(range.startContainer, range.startOffset);
  return { childIndex: [...content.childNodes].indexOf(child), textOffset: offset.toString().length };
}
function restoreBlockCaret(caret: { childIndex: number; textOffset: number } | null, index: number) {
  if (!caret) return;
  const block = document.querySelectorAll<HTMLElement>('#documentBody .md-block')[index + caret.childIndex];
  const content = block?.querySelector<HTMLElement>('.block-content');
  if (!content) return;
  content.focus();
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let remaining = caret.textOffset;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining); range.collapse(true);
      window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
      return;
    }
    remaining -= length;
  }
  const range = document.createRange();
  range.selectNodeContents(content); range.collapse(false);
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
}
function insertMarkdown(text: string) {
  const block = blocks[activeBlock];
  const offset = block?.end ?? source.length;
  const prefix = offset > 0 && !source.slice(0, offset).endsWith('\n\n') ? '\n' : '';
  submitEdit(offset, offset, '', prefix + text + '\n');
}
function insertInline(markdown: string) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const block = selectedBlockElement();
  const selected = selection?.toString().trim();
  if (block?.querySelector('.block-content[contenteditable]') && range) {
    const content = selected || (markdown.startsWith('`') ? '代码' : 'E = mc^2');
    let node: Node;
    if (markdown.startsWith('`')) {
      const code = document.createElement('code'); code.textContent = content; node = code;
    } else {
      const fragment = document.createElement('span');
      fragment.className = 'math-inline';
      fragment.dataset.tex = content;
      fragment.innerHTML = DOMPurify.sanitize(katex.renderToString(content, { throwOnError: false, trust: false, output: 'html' }));
      node = fragment;
    }
    range.deleteContents(); range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    selection?.removeAllRanges(); selection?.addRange(range);
    scheduleBlockSave(block);
  } else insertMarkdown(markdown);
}
function editProtected(index: number) {
  const block = blocks[index]; if (!block) return;
  showDialog('编辑 Markdown 源码', `<textarea id="sourceText" rows="14">${esc(block.raw)}</textarea><div class="dialog-actions"><button data-action="cancelDialog">取消</button><button data-action="saveSource" class="primary">保存</button></div>`, { index });
}
let dialogData: any = null;
function showDialog(title: string, content: string, data: any = null) {
  dialogData = data;
  document.getElementById('dialog')!.innerHTML = `<h2>${esc(title)}</h2>${content}`;
  document.getElementById('dialogBackdrop')!.classList.remove('hidden');
}
function closeDialog() { document.getElementById('dialogBackdrop')!.classList.add('hidden'); dialogData = null; }
function settingField(name: string, label: string, type = 'text', min = '') {
  return `<label>${label}<input id="set-${name}" type="${type}" ${min ? `min="${min}"` : ''} value="${esc(exportSettings[name])}"></label>`;
}
function fontField(name: string, label: string) {
  const current = exportSettings[name] || '';
  const options = [{ family: '', name: '默认（中文宋体，英文跟随编辑器）' }, ...fonts];
  if (current && !options.some(font => font.family === current)) options.push({ family: current, name: current });
  return `<label>${label}<select id="set-${name}">${options.map(font =>
    `<option value="${esc(font.family)}" ${font.family === current ? 'selected' : ''}>${esc(font.name)}</option>`).join('')}</select></label>`;
}
function paperSizeFor(paper: string, orientation: string): [number, number] {
  const sizes: any = { a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4] };
  const size = sizes[paper] || sizes.a4;
  return orientation === 'landscape' ? [size[1], size[0]] : size;
}
function selectedTemplate() {
  return (document.querySelector('input[name=template]:checked') as HTMLInputElement | null)?.value || exportSettings.template;
}
function todayDateText() { return new Date().toLocaleDateString('zh-CN'); }
function customTemplate(id: string) { return templates.find(template => template.id === id); }
function hasBodyVariant(id: string, paper: string, orientation: string) {
  const template = customTemplate(id);
  return !template?.variants || Boolean(template.variants[`${paper}-${orientation}`]?.bodyUrl);
}
function availableVariant(id: string): [string, string] {
  const template = customTemplate(id);
  const key = Object.keys(template?.variants || {}).find(value => template.variants[value]?.bodyUrl) || 'a4-portrait';
  return key.split('-') as [string, string];
}
function updateVariantSelectors() {
  const paper = document.getElementById('set-paper') as HTMLSelectElement | null;
  const orientation = document.getElementById('set-orientation') as HTMLSelectElement | null;
  if (!paper || !orientation) return;
  const id = selectedTemplate();
  for (const option of paper.options) option.disabled = !['portrait', 'landscape'].some(direction => hasBodyVariant(id, option.value, direction));
  if (paper.selectedOptions[0]?.disabled) paper.value = availableVariant(id)[0];
  for (const option of orientation.options) option.disabled = !hasBodyVariant(id, paper.value, option.value);
  if (orientation.selectedOptions[0]?.disabled)
    orientation.value = ['portrait', 'landscape'].find(direction => hasBodyVariant(id, paper.value, direction)) || availableVariant(id)[1];
  const list = document.querySelector<HTMLElement>('.template-list');
  if (list) list.innerHTML = templateOptions(paper.value, orientation.value, id);
}
function setTemplateArtwork(element: HTMLElement, templateId: string, cover = false) {
  const draft = element.id === 'marginSheet' || element.id === 'coverSheet';
  const paper = draft ? (document.getElementById('set-paper') as HTMLSelectElement | null)?.value || exportSettings.paper : exportSettings.paper;
  const orientation = draft ? (document.getElementById('set-orientation') as HTMLSelectElement | null)?.value || exportSettings.orientation : exportSettings.orientation;
  const background = cover ? coverBackground(templateId, paper, orientation) : templateBackground(templateId, paper, orientation);
  element.style.backgroundImage = `url("${background}")`;
  element.style.backgroundSize = '100% 100%';
  element.style.backgroundPosition = 'center';
  element.style.backgroundRepeat = 'no-repeat';
}
function updateMarginSheet() {
  const sheet = document.getElementById('marginSheet') as HTMLElement | null;
  const selection = document.getElementById('marginSelection') as HTMLElement | null;
  if (!sheet || !selection || !marginDraft) return;
  const [width, height] = paperSizeFor((document.getElementById('set-paper') as HTMLSelectElement).value,
    (document.getElementById('set-orientation') as HTMLSelectElement).value);
  sheet.style.width = `${230 * width / height}px`;
  setTemplateArtwork(sheet, selectedTemplate());
  selection.style.left = `${marginDraft.marginLeft / width * 100}%`;
  selection.style.right = `${marginDraft.marginRight / width * 100}%`;
  selection.style.top = `${marginDraft.marginTop / height * 100}%`;
  selection.style.bottom = `${marginDraft.marginBottom / height * 100}%`;
  const number = document.getElementById('marginPageNumber') as HTMLElement;
  number.style.display = (document.getElementById('set-pageNumbers') as HTMLInputElement).checked ? '' : 'none';
  number.style.right = `${10 / width * 100}%`;
  number.style.bottom = `${7 / height * 100}%`;
  document.getElementById('marginText')!.textContent = `正文区域：上 ${Math.round(marginDraft.marginTop)}、右 ${Math.round(marginDraft.marginRight)}、下 ${Math.round(marginDraft.marginBottom)}、左 ${Math.round(marginDraft.marginLeft)} mm`;
  for (const key of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']) {
    const field = document.getElementById('set-' + key) as HTMLInputElement | null;
    if (field) field.value = String(marginDraft[key]);
  }
}
function updateCoverSheet() {
  const sheet = document.getElementById('coverSheet') as HTMLElement | null;
  if (!sheet || !coverDraft) return;
  const [width, height] = paperSizeFor((document.getElementById('set-paper') as HTMLSelectElement).value,
    (document.getElementById('set-orientation') as HTMLSelectElement).value);
  sheet.style.width = `${330 * width / height}px`;
  setTemplateArtwork(sheet, selectedTemplate(), true);
  const values: Record<string, string> = {
    title: blocks.find(block => /^#\s+/.test(block.raw))?.raw.replace(/^#\s+/, '').trim() || '文档标题',
    subtitle: (document.getElementById('set-coverSubtitle') as HTMLInputElement).value || '副标题',
    author: (document.getElementById('set-coverAuthor') as HTMLInputElement).value || '作者',
    date: (document.getElementById('set-coverDateText') as HTMLInputElement).value || todayDateText()
  };
  for (const key of ['title', 'subtitle', 'author', 'date']) {
    const field = sheet.querySelector<HTMLElement>(`[data-cover-field="${key}"]`)!;
    field.style.left = `${coverDraft[key][0]}%`;
    field.style.top = `${coverDraft[key][1]}%`;
    field.querySelector('.cover-drag-value')!.textContent = values[key];
    field.classList.toggle('inactive', key === 'date' && !(document.getElementById('set-coverDate') as HTMLInputElement).checked);
  }
}
function bindCoverSheet() {
  const sheet = document.getElementById('coverSheet') as HTMLElement;
  let drag: { key: string; x: number; y: number; position: [number, number] } | null = null;
  for (const field of sheet.querySelectorAll<HTMLElement>('[data-cover-field]')) {
    field.addEventListener('pointerdown', event => {
      const key = field.dataset.coverField!;
      drag = { key, x: event.clientX, y: event.clientY, position: [...coverDraft![key]] as [number, number] };
      field.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    field.addEventListener('pointermove', event => {
      if (!drag || drag.key !== field.dataset.coverField) return;
      const rect = sheet.getBoundingClientRect();
      coverDraft![drag.key] = [
        Math.max(0, Math.min(100, Math.round(drag.position[0] + (event.clientX - drag.x) / rect.width * 100))),
        Math.max(0, Math.min(100, Math.round(drag.position[1] + (event.clientY - drag.y) / rect.height * 100)))
      ];
      updateCoverSheet();
    });
    field.addEventListener('pointerup', () => { drag = null; });
    field.addEventListener('pointercancel', () => { drag = null; });
    field.addEventListener('keydown', event => {
      const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const delta = offsets[event.key];
      if (!delta) return;
      const key = field.dataset.coverField!;
      const step = event.shiftKey ? 5 : 1;
      coverDraft![key] = coverDraft![key].map((value, index) => Math.max(0, Math.min(100, value + delta[index] * step))) as [number, number];
      updateCoverSheet(); event.preventDefault();
    });
  }
}
function bindMarginSheet() {
  const sheet = document.getElementById('marginSheet') as HTMLElement;
  let start: { x: number; y: number } | null = null;
  const coords = (event: PointerEvent) => {
    const rect = sheet.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  sheet.addEventListener('pointerdown', event => {
    start = coords(event);
    const [width, height] = paperSizeFor((document.getElementById('set-paper') as HTMLSelectElement).value,
      (document.getElementById('set-orientation') as HTMLSelectElement).value);
    const side = Math.min(60, Math.round(start.x * width));
    const vertical = Math.max(18, Math.min(60, Math.round(start.y * height)));
    marginDraft = { marginLeft: side, marginRight: side, marginTop: vertical, marginBottom: vertical };
    updateMarginSheet();
    sheet.setPointerCapture(event.pointerId);
  });
  sheet.addEventListener('pointermove', event => {
    if (!start) return;
    const end = coords(event);
    const [width, height] = paperSizeFor((document.getElementById('set-paper') as HTMLSelectElement).value,
      (document.getElementById('set-orientation') as HTMLSelectElement).value);
    if (Math.abs(end.x - start.x) * width < 6 && Math.abs(end.y - start.y) * height < 6) return;
    const right = Math.max(0, Math.min(60, Math.round((1 - end.x) * width)));
    const bottom = Math.max(18, Math.min(60, Math.round((1 - end.y) * height)));
    marginDraft.marginRight = Math.abs(right - marginDraft.marginLeft) <= 3 ? marginDraft.marginLeft : right;
    marginDraft.marginBottom = Math.abs(bottom - marginDraft.marginTop) <= 3 ? marginDraft.marginTop : bottom;
    updateMarginSheet();
  });
  sheet.addEventListener('pointerup', () => { start = null; });
  sheet.addEventListener('pointercancel', () => { start = null; });
}
function settingsDialog() {
  marginDraft = Object.fromEntries(['marginTop','marginRight','marginBottom','marginLeft'].map(key => [key, exportSettings[key]]));
  coverDraft = Object.fromEntries(['title', 'subtitle', 'author', 'date'].map(key => [key, [...(exportSettings.coverPositions?.[key] || [50, 50])]])) as Record<string, [number, number]>;
  showDialog('PDF 排版设置', `<div class="setting-grid">
    <div class="template-settings"><strong>模板</strong><div class="template-list">${templateOptions()}</div><button data-action="importTemplate">导入图片模板</button><p>导入后选择有内页的纸张和方向；封面图片可选。应用模板后可在文档预览中框选文字，将模板用于该范围。</p></div>
    <label>纸张<select id="set-paper"><option value="a4">A4</option><option value="a5">A5</option><option value="letter">Letter</option></select></label>
    <label>方向<select id="set-orientation"><option value="portrait">纵向</option><option value="landscape">横向</option></select></label>
    <div class="margin-editor"><strong>页边距</strong><p>点击确定左上角，右下角自动对称；拖动可调整，靠近对称位置时自动吸附</p><div id="marginSheet" class="margin-sheet" role="img" aria-label="点击或拖动调整 PDF 正文区域"><div id="marginSelection" class="margin-selection"></div><span id="marginPageNumber" class="margin-page-number">1 / 3</span></div><p id="marginText"></p>
      <div class="margin-inputs"><label>上 mm<input id="set-marginTop" type="number" min="0" max="60" step="1"></label><label>右 mm<input id="set-marginRight" type="number" min="0" max="60" step="1"></label><label>下 mm<input id="set-marginBottom" type="number" min="18" max="60" step="1"></label><label>左 mm<input id="set-marginLeft" type="number" min="0" max="60" step="1"></label></div><p>页码固定在右下角；底边距至少 18 mm，避免碰到正文。</p></div>
    ${settingField('fontSize','正文字号 pt','number','6')}${settingField('lineHeight','行距','number','1')}
    ${settingField('paragraphGap','段落间距 px','number','0')}${settingField('firstLineIndent','首行缩进 em','number','0')}
    <label>对齐<select id="set-align"><option value="left">左对齐</option><option value="justify">两端对齐</option><option value="center">居中</option></select></label>
    ${fontField('fontFamily','正文字体')}${fontField('titleFontFamily','标题字体')}
    <div class="font-setting"><button data-action="importFont" type="button">导入字体文件</button><p>支持 TTF、OTF、WOFF、WOFF2；导入后可在上方选择。</p></div>
    ${settingField('headingScale','标题大小倍率','number','0.5')}${settingField('headingGap','标题间距倍率','number','0.5')}
    ${settingField('codeBackground','代码块背景','color')}${settingField('tableHeaderBackground','表头背景','color')}
    ${settingField('tableBorderColor','表格边框','color')}
    ${settingField('header','页眉')}${settingField('footer','页脚')}
    <label>页码格式<select id="set-pageNumberFormat"><option value="fraction">当前页 / 总页数</option><option value="number">仅页码</option></select></label>
    <label><input id="set-pageNumbers" type="checkbox" ${exportSettings.pageNumbers ? 'checked' : ''}>显示页码</label>
    <label><input id="set-cover" type="checkbox" ${exportSettings.cover ? 'checked' : ''}>封面页</label>
    ${settingField('coverSubtitle','封面副标题')}${settingField('coverAuthor','封面作者')}
    <label><input id="set-coverDate" type="checkbox" ${exportSettings.coverDate !== false ? 'checked' : ''}>显示封面日期</label>
    <label>封面日期文字<input id="set-coverDateText" type="text" value="${esc(exportSettings.coverDateText || todayDateText())}"></label>
    <div class="cover-position-settings"><strong>封面文字位置</strong><p>在封面模板上拖动文字；选中文字后也可用方向键微调，按 Shift 每次移动 5%。</p><div id="coverSheet" class="cover-sheet" aria-label="拖动调整封面文字位置">${['title','subtitle','author','date'].map((key, i) => `<div class="cover-drag-field ${key}" data-cover-field="${key}" role="button" tabindex="0" aria-label="拖动${['标题','副标题','作者','日期'][i]}"><span class="cover-drag-label">${['标题','副标题','作者','日期'][i]}</span><span class="cover-drag-value"></span></div>`).join('')}</div></div>
    <label><input id="set-toc" type="checkbox" ${exportSettings.toc ? 'checked' : ''}>自动目录</label>
    </div><div class="dialog-actions"><button data-action="cancelDialog">取消</button><button data-action="saveSettings" class="primary">应用</button></div>`);
  for (const key of ['paper','orientation','align','pageNumberFormat']) (document.getElementById('set-' + key) as HTMLSelectElement).value = exportSettings[key];
  updateVariantSelectors();
  updateMarginSheet(); bindMarginSheet(); updateCoverSheet(); bindCoverSheet();
}
function templateImportDialog() {
  const draft = templateImportDraft ||= { name: '', slots: {} };
  const papers = [{ key: 'a4', name: 'A4' }, { key: 'a5', name: 'A5' }, { key: 'letter', name: 'Letter' }];
  const rows = papers.flatMap(paper => ['portrait', 'landscape'].map(orientation => {
    const key = `${paper.key}-${orientation}`;
    const cells = ['body', 'cover'].map(kind => {
      const slot = `${key}-${kind}`;
      const selected = draft.slots[slot];
      return `<div class="template-import-cell"><button data-action="pickTemplateImage" data-slot="${slot}">${selected ? '更换' : '选择'}${kind === 'body' ? '内页' : '封面'}</button>${selected ? `<button data-action="removeTemplateImage" data-slot="${slot}" aria-label="移除${esc(selected.name)}">移除</button><small title="${esc(selected.name)}">${esc(selected.name)}</small><img src="${esc(selected.url)}" alt="${esc(selected.name)}">` : '<small>未导入</small>'}</div>`;
    }).join('');
    return `<div class="template-import-row"><strong>${paper.name} · ${orientation === 'portrait' ? '纵向' : '横向'}</strong>${cells}</div>`;
  })).join('');
  showDialog('导入图片模板', `<div class="template-import"><label>模板名称<input id="templateImportName" maxlength="80" value="${esc(draft.name)}" placeholder="例如：学院论文模板"></label>
    <p>每个纸张与方向可分别导入内页和封面；至少要有一张内页。没有封面时使用同规格内页。未提供内页的规格无法选择。</p>
    <div class="template-import-head"><span>纸张与方向</span><span>内页（必需其一）</span><span>封面（可选）</span></div>${rows}
    <p>支持 PNG、JPEG、WebP、SVG；单张不超过 20 MB。建议按对应纸张比例制作，清晰图片建议至少 150 dpi，避免拉伸。</p></div>
    <div class="dialog-actions"><button data-action="cancelTemplateImport">返回设置</button><button data-action="saveTemplateImport" class="primary" ${Object.keys(draft.slots).some(slot => slot.endsWith('-body')) ? '' : 'disabled'}>保存模板</button></div>`);
}
function templateOptions(paper = exportSettings.paper, orientation = exportSettings.orientation, selected = exportSettings.template) {
  const all = [
    { id: 'simple', name: '简洁文档' }, { id: 'academic', name: '学术报告' }, { id: 'technical', name: '技术文档' },
    { id: 'sjtu-red', name: '上海交大 · 红' }, { id: 'sjtu-blue', name: '上海交大 · 蓝' }, ...templates
  ];
  return all.map(t => {
    const previewPaper = hasBodyVariant(t.id, paper, orientation) ? paper : availableVariant(t.id)[0];
    const previewOrientation = hasBodyVariant(t.id, paper, orientation) ? orientation : availableVariant(t.id)[1];
    const background = templateBackground(t.id, previewPaper, previewOrientation);
    const [paperWidth, paperHeight] = paperSizeFor(paper, orientation);
    const thumbHeight = orientation === 'landscape' ? 80 : 110;
    const style = `background-image:url(${JSON.stringify(background)});width:${thumbHeight * paperWidth / paperHeight}px;height:${thumbHeight}px`;
    return `<label class="template-option">
    <input type="radio" name="template" value="${esc(t.id)}" ${selected === t.id ? 'checked' : ''}>
    <span class="template-thumb ${esc(t.id)}" style="${esc(style)}"></span>
    <span>${esc(t.name)}</span>${!hasBodyVariant(t.id, paper, orientation) ? '<small>当前纸张/方向不可用</small>' : ''}${(t.url || t.variants) ? `<button data-action="exportTemplate" data-id="${esc(t.id)}">导出正文</button>` : ''}
  </label>`;
  }).join('');
}
function onChange(event: Event) {
  const target = event.target as HTMLInputElement;
  if (target.id === 'set-paper' || target.id === 'set-orientation' || target.name === 'template' || target.id === 'set-pageNumbers') {
    if (target.id === 'set-paper' || target.id === 'set-orientation' || target.name === 'template') updateVariantSelectors();
    updateMarginSheet(); updateCoverSheet();
  }
  if (['set-coverDate', 'set-coverSubtitle', 'set-coverAuthor'].includes(target.id)) updateCoverSheet();
  const marginKey = target.id.replace(/^set-/, '');
  if (marginDraft && ['marginTop','marginRight','marginBottom','marginLeft'].includes(marginKey)) {
    const minimum = marginKey === 'marginBottom' ? 18 : 0;
    const value = Number(target.value);
    marginDraft[marginKey] = Number.isFinite(value) ? Math.max(minimum, Math.min(60, value)) : minimum;
    target.value = String(marginDraft[marginKey]); updateMarginSheet();
  }
  if (target.id === 'autoUpdate') {
    autoUpdate = target.checked; if (autoUpdate) schedulePdf();
  }
  if (target.id === 'blockType') {
    const block = document.querySelector<HTMLElement>(`#documentBody .md-block[data-index="${activeBlock}"]`);
    const current = block?.querySelector<HTMLElement>('.block-content > :first-child');
    if (current && /^(P|H[1-6])$/.test(current.tagName)) {
      const replacement = document.createElement(target.value);
      replacement.innerHTML = current.innerHTML; current.replaceWith(replacement);
      scheduleBlockSave(block!);
    }
  }
  if (target.matches('input[type=checkbox]') && target.closest('.md-block')) scheduleBlockSave(target.closest('.md-block') as HTMLElement);
}
function onClick(event: MouseEvent) {
  const clickedBlock = (event.target as HTMLElement).closest('.md-block') as HTMLElement | null;
  if (clickedBlock) activeBlock = Number(clickedBlock.dataset.index);
  const image = (event.target as HTMLElement).closest('img') as HTMLImageElement | null;
  if (image && mode === 'visual' && clickedBlock) {
    showDialog('编辑图片', '<label>说明文字<input id="imageAlt"></label><label>路径或 URL<input id="imageUrl"></label><div class="dialog-actions"><button data-action="cancelDialog">取消</button><button data-action="removeImage">删除图片</button><button data-action="updateImage" class="primary">保存</button></div>', { image });
    (document.getElementById('imageAlt') as HTMLInputElement).value = image.alt || '';
    (document.getElementById('imageUrl') as HTMLInputElement).value = image.dataset.originalSrc || image.getAttribute('src') || '';
    return;
  }
  const link = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
  if (link) {
    const href = link.getAttribute('href') || '';
    if (mode === 'visual' && link.closest('.md-block')) {
      event.preventDefault();
      toast('双击编辑链接；Ctrl+单击打开链接');
      if (event.ctrlKey || event.metaKey) {
        if (/^(https?:|mailto:)/i.test(href)) post('openLink', { url: href });
        else if (href && !href.startsWith('#')) post('openLocalLink', { href });
      }
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) { event.preventDefault(); post('openLink', { url: href }); }
    else if (href && !href.startsWith('#')) { event.preventDefault(); post('openLocalLink', { href }); }
    return;
  }
  const button = (event.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
  if (!button) return;
  const action = button.dataset.action!;
  if (['source','split','visual','pdf'].includes(action)) {
    if (action === 'pdf' && mode === 'visual') {
      visualPdf = !visualPdf; document.getElementById('workspace')!.classList.toggle('with-pdf', visualPdf);
      updatePdfActions();
      if (!visualPdf) {
        root.classList.remove('pdf-full');
        const expand = root.querySelector<HTMLButtonElement>('button[data-action="fullPdf"]');
        if (expand) { expand.textContent = '展开 PDF'; expand.setAttribute('aria-pressed', 'false'); }
      }
      if (visualPdf) schedulePdf(); return;
    }
    post(action); return;
  }
  if (action === 'settings') return settingsDialog();
  if (action === 'cancelDialog') return closeDialog();
  if (action === 'importTemplate') { templateImportDraft = { name: '', slots: {} }; return templateImportDialog(); }
  if (action === 'pickTemplateImage') return post('pickTemplateImage', { slot: button.dataset.slot });
  if (action === 'removeTemplateImage') {
    const slot = button.dataset.slot!;
    delete templateImportDraft?.slots[slot]; post('removeTemplateImage', { slot }); return templateImportDialog();
  }
  if (action === 'cancelTemplateImport') { post('discardTemplateDraft'); templateImportDraft = null; return settingsDialog(); }
  if (action === 'saveTemplateImport') {
    if (!templateImportDraft?.name.trim()) return toast('请填写模板名称', true);
    if (!Object.keys(templateImportDraft.slots).some(slot => slot.endsWith('-body'))) return toast('至少需要一张内页图片', true);
    if (Object.keys(templateImportDraft.slots).some(slot => slot.endsWith('-cover') && !templateImportDraft!.slots[slot.replace(/-cover$/, '-body')])) return toast('封面需要相同纸张和方向的内页', true);
    return post('saveTemplateImport', { name: templateImportDraft.name.trim() });
  }
  if (action === 'importFont') return post('importFont');
  if (action === 'exportTemplate') return post('exportTemplate', { id: button.dataset.id,
    paper: (document.getElementById('set-paper') as HTMLSelectElement)?.value || exportSettings.paper,
    orientation: (document.getElementById('set-orientation') as HTMLSelectElement)?.value || exportSettings.orientation });
  if (action === 'saveSettings') {
    for (const key of ['paper','orientation','align','fontFamily','titleFontFamily','codeBackground','tableHeaderBackground','tableBorderColor','header','footer','pageNumberFormat','coverSubtitle','coverAuthor']) exportSettings[key] = (document.getElementById('set-' + key) as HTMLInputElement).value;
    const dateText = (document.getElementById('set-coverDateText') as HTMLInputElement).value.trim();
    exportSettings.coverDateText = dateText === todayDateText() && !exportSettings.coverDateText ? '' : dateText;
    const chosenTemplate = (document.querySelector('input[name=template]:checked') as HTMLInputElement)?.value || 'simple';
    if (!hasBodyVariant(chosenTemplate, exportSettings.paper, exportSettings.orientation)) return toast('当前模板不支持所选纸张和方向', true);
    if (chosenTemplate !== exportSettings.template) {
      exportSettings.baseTemplate = exportSettings.template;
      exportSettings.templateRanges = [];
      templateBrush = mode !== 'pdf' ? chosenTemplate : null;
    }
    exportSettings.template = chosenTemplate;
    Object.assign(exportSettings, marginDraft);
    for (const key of ['fontSize','lineHeight','paragraphGap','firstLineIndent','headingScale','headingGap']) exportSettings[key] = Number((document.getElementById('set-' + key) as HTMLInputElement).value);
    for (const key of ['pageNumbers','cover','coverDate','toc']) exportSettings[key] = (document.getElementById('set-' + key) as HTMLInputElement).checked;
    exportSettings.coverPositions = Object.fromEntries(['title','subtitle','author','date'].map(key => [key,
      coverDraft![key].map(value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50)]));
    normalizeExportSettings();
    pdfDirty = true; post('saveSettings', { value: exportSettings }); closeDialog(); schedulePdf();
    if (templateBrush) toast('模板已选中；在文档预览中框选正文，即可将模板应用到该范围。');
    return;
  }
  if (action === 'saveSource') {
    const block = blocks[dialogData?.index];
    if (block) submitEdit(block.start, block.end, block.raw, (document.getElementById('sourceText') as HTMLTextAreaElement).value);
    closeDialog(); return;
  }
  if (action === 'editSource') return editProtected(Number(button.closest('.md-block')?.getAttribute('data-index')));
  if (action === 'refresh') { imageDataCache.clear(); return schedulePdf(true); }
  if (action === 'export') return exportPdf();
  if (action === 'prev') return jumpPage(pdfPage - 1);
  if (action === 'next') return jumpPage(pdfPage + 1);
  if (action === 'zoomOut') return setScale(pdfScale / 1.2);
  if (action === 'zoomIn') return setScale(pdfScale * 1.2);
  if (action === 'breakMarkers') {
    showBreaks = !showBreaks; root.classList.toggle('hide-breaks', !showBreaks);
    button.textContent = showBreaks ? '隐藏分页标记' : '显示分页标记'; button.setAttribute('aria-pressed', String(showBreaks));
    markPageBoundaries();
    post('pageBoundaries', { boundaries: showBreaks ? pageBoundaries : [] });
    return;
  }
  if (action === 'fullPdf') {
    const expanded = root.classList.toggle('pdf-full');
    button.textContent = expanded ? '返回对照' : '展开 PDF'; button.setAttribute('aria-pressed', String(expanded));
    return;
  }
  if (action === 'bold' || action === 'italic' || action === 'strike') {
    document.execCommand(action === 'strike' ? 'strikeThrough' : action); const block = selectedBlockElement(); if (block) scheduleBlockSave(block); return;
  }
  if (action === 'link') {
    const selected = window.getSelection();
    const existing = (selected?.anchorNode?.nodeType === 1 ? selected.anchorNode as Element : selected?.anchorNode?.parentElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (existing) return editLink(existing);
    savedRange = selected?.rangeCount ? selected.getRangeAt(0).cloneRange() : null;
    const selectedText = selected?.toString() || '';
    showDialog('插入链接', '<label>文字<input id="linkText" placeholder="链接文字"></label><label>地址<input id="linkUrl" placeholder="https://example.com"></label><div class="dialog-actions"><button data-action="cancelDialog">取消</button><button data-action="insertLink" class="primary">插入</button></div>');
    (document.getElementById('linkText') as HTMLInputElement).value = selectedText;
    return;
  }
  if (action === 'insertLink') {
    const text = (document.getElementById('linkText') as HTMLInputElement).value || '链接';
    const url = (document.getElementById('linkUrl') as HTMLInputElement).value;
    if (safeHref(url)) {
      const block = savedRange?.commonAncestorContainer?.parentElement?.closest('.md-block') as HTMLElement | null;
      if (block?.querySelector('.block-content[contenteditable]')) {
        const anchor = document.createElement('a'); anchor.href = url; anchor.textContent = text;
        savedRange!.deleteContents(); savedRange!.insertNode(anchor); scheduleBlockSave(block);
      } else insertMarkdown(`[${text.replace(/]/g,'\\]')}](${url.replace(/\)/g,'%29')})`);
    }
    else toast('链接必须是 http、https、mailto 或文档锚点', true);
    savedRange = null; closeDialog(); return;
  }
  if (action === 'updateLink' || action === 'removeLink') {
    const link = dialogData?.link as HTMLAnchorElement | undefined;
    const block = link?.closest('.md-block') as HTMLElement | null;
    if (link && block) {
      if (action === 'removeLink') link.replaceWith(document.createTextNode(link.textContent || ''));
      else {
        const url = (document.getElementById('linkUrl') as HTMLInputElement).value;
        if (!safeHref(url)) { toast('链接地址不安全', true); return; }
        link.href = url; link.textContent = (document.getElementById('linkText') as HTMLInputElement).value;
      }
      scheduleBlockSave(block);
    }
    closeDialog(); return;
  }
  if (action === 'image') {
    showDialog('插入图片', '<label>说明文字<input id="imageAlt"></label><label>路径或 URL<input id="imageUrl"></label><div class="dialog-actions"><button data-action="cancelDialog">取消</button><button data-action="insertImage" class="primary">插入</button></div>');
    return;
  }
  if (action === 'insertImage') {
    const alt = (document.getElementById('imageAlt') as HTMLInputElement).value.replace(/]/g, '\\]');
    const url = (document.getElementById('imageUrl') as HTMLInputElement).value.replace(/\)/g, '%29');
    if (url && !/^javascript:/i.test(url)) insertMarkdown(`![${alt}](${url})`);
    closeDialog(); return;
  }
  if (action === 'updateImage' || action === 'removeImage') {
    const image = dialogData?.image as HTMLImageElement | undefined;
    const block = image?.closest('.md-block') as HTMLElement | null;
    if (image && block) {
      if (action === 'removeImage') image.remove();
      else {
        const url = (document.getElementById('imageUrl') as HTMLInputElement).value.trim();
        if (!url || /^(javascript:|vbscript:)/i.test(url)) { toast('图片地址无效', true); return; }
        image.alt = (document.getElementById('imageAlt') as HTMLInputElement).value;
        image.dataset.originalSrc = url;
        image.classList.remove('missing-image');
        image.removeAttribute('src');
        void localizeImages(image);
      }
      scheduleBlockSave(block);
    }
    closeDialog(); return;
  }
  if (action === 'ul') return insertMarkdown('- 列表项');
  if (action === 'ol') return insertMarkdown('1. 列表项');
  if (action === 'quote') return insertMarkdown('> 引用内容');
  if (action === 'table') return insertMarkdown('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |');
  if (action === 'inlineCode') return insertInline('`代码`');
  if (action === 'code') return insertMarkdown('```text\n代码\n```');
  if (action === 'inlineMath') return insertInline('$E = mc^2$');
  if (action === 'math') return insertMarkdown('$$\nE = mc^2\n$$');
  if (action === 'mermaid') return insertMarkdown('```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```');
  if (action === 'break') {
    showDialog('手动分页', '<p>分页符会以 <code>&lt;!-- pagebreak --&gt;</code> 保存到 Markdown。</p><div class="dialog-actions"><button data-action="breakBefore">在当前段落前</button><button data-action="breakAfter">在当前段落后</button><button data-action="removeBreak">删除当前分页</button><button data-action="clearBreaks">清除全部分页</button><button data-action="cancelDialog">关闭</button></div>');
    return;
  }
  if (action === 'breakBefore') {
    const block = blocks[activeBlock]; const offset = block?.start ?? 0;
    submitEdit(offset, offset, '', '<!-- pagebreak -->\n\n');
    closeDialog(); return;
  }
  if (action === 'breakAfter') { insertMarkdown('<!-- pagebreak -->'); closeDialog(); return; }
  if (action === 'removeBreak') {
    const block = blocks[activeBlock];
    if (block && /^\s*<!--\s*pagebreak\s*-->\s*$/i.test(block.raw))
      submitEdit(block.start, block.end, block.raw, '');
    else toast('请先选择一个手动分页标记', true);
    closeDialog(); return;
  }
  if (action === 'clearBreaks') {
    const next = source.replace(/^\s*<!--\s*pagebreak\s*-->\s*\n?/gim, '');
    submitEdit(0, source.length, source, next);
    closeDialog(); return;
  }
  if (['row', 'column', 'deleteRow', 'deleteColumn'].includes(action)) {
    const block = savedTableCell?.closest('.md-block') as HTMLElement | null;
    const table = block?.querySelector('table');
    if (!table) { toast('请先将光标放入表格', true); return; }
    if (action === 'row') {
      const row = table.querySelector('tbody tr:last-child') || table.querySelector('tr:last-child');
      if (row) { const clone = row.cloneNode(true) as HTMLElement; clone.querySelectorAll('td,th').forEach(cell => cell.textContent = ''); row.after(clone); }
    } else if (action === 'column') {
      table.querySelectorAll('tr').forEach(row => { const cell = document.createElement(row.parentElement?.tagName === 'THEAD' ? 'th' : 'td'); cell.textContent = ''; row.append(cell); });
    } else if (action === 'deleteRow') {
      const row = (savedTableCell?.closest('tr') as HTMLElement) || table.querySelector('tbody tr:last-child');
      if (row && table.querySelectorAll('tr').length > 2) row.remove();
    } else {
      const cell = savedTableCell;
      const index = cell ? [...cell.parentElement!.children].indexOf(cell) : table.querySelector('tr')!.children.length - 1;
      if (table.querySelector('tr')!.children.length > 1) table.querySelectorAll('tr').forEach(row => row.children[index]?.remove());
    }
    if (block) scheduleBlockSave(block);
  }
}

const mmToPx = (mm: number) => mm * 96 / 25.4;
function paperSize() {
  return paperSizeFor(exportSettings.paper, exportSettings.orientation);
}
function templateBackground(templateId = exportSettings.template, paper = exportSettings.paper, orientation = exportSettings.orientation) {
  const custom = templates.find(t => t.id === templateId);
  if (custom?.variants) return custom.variants[`${paper}-${orientation}`]?.bodyUrl || '';
  if (custom?.url) return custom.url;
  if (templateId === 'sjtu-red' || templateId === 'sjtu-blue') return boot.templateUrls?.[`${templateId}-${paper}-${orientation}`];
  if (boot.templateUrls?.[templateId]) return boot.templateUrls[templateId];
  const variants: any = {
    simple: '<rect x="0" y="0" width="100%" height="100%" fill="white"/>',
    academic: '<rect x="0" y="0" width="100%" height="100%" fill="white"/><path d="M42 70H958M42 1330H958" stroke="#9b7c62" stroke-width="2"/><rect x="42" y="77" width="24" height="3" fill="#9b7c62"/>',
    technical: '<rect x="0" y="0" width="100%" height="100%" fill="white"/><rect x="0" y="0" width="1000" height="20" fill="#245482"/><path d="M50 1325H950" stroke="#245482" stroke-width="2"/><circle cx="950" cy="54" r="7" fill="#245482"/>'
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400" viewBox="0 0 1000 1400">${variants[templateId] || variants.simple}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function coverBackground(templateId = exportSettings.template, paper = exportSettings.paper, orientation = exportSettings.orientation) {
  const custom = templates.find(t => t.id === templateId);
  if (custom?.variants) {
    const variant = custom.variants[`${paper}-${orientation}`];
    return variant?.coverUrl || variant?.bodyUrl || '';
  }
  if (custom?.coverUrl || custom?.url) return custom.coverUrl || custom.url;
  if (templateId === 'sjtu-red' || templateId === 'sjtu-blue') return boot.templateUrls?.[`${templateId}-${paper}-${orientation}-cover`];
  if (boot.templateUrls?.[`${templateId}-cover`]) return boot.templateUrls[`${templateId}-cover`];
  if (boot.templateUrls?.cover) return boot.templateUrls.cover;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400"><rect width="100%" height="100%" fill="#fdfbf7"/><path d="M90 260H910M90 1100H910" stroke="#315577" stroke-width="5"/><rect x="90" y="270" width="72" height="8" fill="#315577"/></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function makePage(number: number, total = 0, cover = false, templateId = exportSettings.template): HTMLElement {
  const [width, height] = paperSize();
  const page = document.createElement('div');
  page.className = 'print-page' + (cover ? ' cover-page' : '');
  if (templateId === 'sjtu-red' || templateId === 'sjtu-blue') page.classList.add(templateId);
  page.style.width = `${mmToPx(width)}px`;
  page.style.height = `${mmToPx(height)}px`;
  page.style.setProperty('--margin-top', `${mmToPx(exportSettings.marginTop)}px`);
  page.style.setProperty('--margin-right', `${mmToPx(exportSettings.marginRight)}px`);
  page.style.setProperty('--margin-bottom', `${mmToPx(exportSettings.marginBottom)}px`);
  page.style.setProperty('--margin-left', `${mmToPx(exportSettings.marginLeft)}px`);
  page.style.setProperty('--print-font-size', `${Math.max(6, Number(exportSettings.fontSize)) * 96 / 72}px`);
  page.style.setProperty('--print-line-height', String(exportSettings.lineHeight || 1.5));
  page.style.setProperty('--print-paragraph-gap', `${Number(exportSettings.paragraphGap) || 0}px`);
  page.style.setProperty('--print-indent', `${Number(exportSettings.firstLineIndent) || 0}em`);
  page.style.setProperty('--print-align', exportSettings.align || 'left');
  page.style.setProperty('--print-font-family', exportSettings.fontFamily?.trim() || settings.editorFontFamily || 'monospace');
  page.style.setProperty('--print-title-family', exportSettings.titleFontFamily?.trim() || settings.editorFontFamily || 'monospace');
  page.style.setProperty('--print-heading-scale', String(exportSettings.headingScale || 1));
  page.style.setProperty('--print-heading-gap', String(exportSettings.headingGap || 1));
  page.style.setProperty('--print-code-bg', exportSettings.codeBackground || '#f4f6f8');
  page.style.setProperty('--print-table-header', exportSettings.tableHeaderBackground || '#eef2f6');
  page.style.setProperty('--print-table-border', exportSettings.tableBorderColor || '#aab4bf');
  page.innerHTML = cover ? '<div class="print-cover-content"></div>' :
    `<div class="print-header">${esc(exportSettings.header || '')}</div>
    <div class="print-content markdown-body"></div>
    <div class="print-footer">${esc(exportSettings.footer || '')}</div>
    <div class="print-page-number">${exportSettings.pageNumbers ? number : ''}</div>`;
  applyChinesePrintFont(page);
  setTemplateArtwork(page, templateId, cover);
  return page;
}
function applyChinesePrintFont(container: HTMLElement) {
  if (exportSettings.fontFamily?.trim()) return;
  const pattern = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]+/gu;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest('pre, code, .katex, svg, script, style, .print-chinese')) continue;
    if (exportSettings.titleFontFamily?.trim() && parent.closest('h1, h2, h3, h4, h5, h6')) continue;
    const value = node.data;
    pattern.lastIndex = 0;
    if (!pattern.test(value)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index || 0;
      if (index > offset) fragment.append(document.createTextNode(value.slice(offset, index)));
      const span = document.createElement('span');
      span.className = 'print-chinese';
      span.textContent = match[0];
      fragment.append(span);
      offset = index + match[0].length;
    }
    if (offset < value.length) fragment.append(document.createTextNode(value.slice(offset)));
    node.replaceWith(fragment);
  }
}
function makePrintBlock(block: Block): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'print-block';
  wrapper.innerHTML = block.html;
  applyChinesePrintFont(wrapper);
  return wrapper;
}
function waitImages(container: HTMLElement) {
  const images = [...container.querySelectorAll<HTMLImageElement>('img')];
  return Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise<void>(resolve => {
    img.onload = () => resolve(); img.onerror = () => resolve(); setTimeout(resolve, 3000);
  })));
}
function textLineBottoms(element: HTMLElement): number[] {
  const top = element.getBoundingClientRect().top;
  const bottoms: number[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.height) bottoms.push(rect.bottom - top);
  }
  return [...new Set(bottoms.map(value => Math.round(value * 10) / 10))].sort((a, b) => a - b);
}
async function paginate() {
  const host = document.getElementById('printHost')!;
  host.innerHTML = '';
  const pages: HTMLElement[] = [];
  const boundaries: Array<{ line: number; page: number; type: string }> = [];
  const title = blocks.find(b => /^#\s+/.test(b.raw))?.raw.replace(/^#\s+/, '').trim() || '文档';
  if (exportSettings.cover) {
    const cover = makePage(1, 0, true);
    const fields = [
      ['title', title], ['subtitle', exportSettings.coverSubtitle],
      ['author', exportSettings.coverAuthor], ['date', exportSettings.coverDate !== false ? exportSettings.coverDateText || todayDateText() : '']
    ];
    cover.querySelector('.print-cover-content')!.innerHTML = fields.filter(([, value]) => value).map(([key, value]) => {
      const position = exportSettings.coverPositions?.[key] || [50, 50];
      const x = Math.max(0, Math.min(100, Number(position[0]) || 0));
      const y = Math.max(0, Math.min(100, Number(position[1]) || 0));
      return `<div class="cover-field cover-${key}" style="left:${x}%;top:${y}%">${esc(value)}</div>`;
    }).join('');
    applyChinesePrintFont(cover.querySelector<HTMLElement>('.print-cover-content')!);
    host.append(cover); pages.push(cover);
  }
  const templateForBlock = (index: number) => {
    const ranges = exportSettings.templateRanges || [];
    if (!ranges.length) return exportSettings.template;
    return ranges.find((range: any) => index >= range.start && index <= range.end)?.id || exportSettings.baseTemplate || exportSettings.template;
  };
  let currentTemplate = templateForBlock(0);
  let page = makePage(pages.length + 1, 0, false, currentTemplate);
  host.append(page); pages.push(page);
  let content = page.querySelector<HTMLElement>('.print-content')!;
  if (exportSettings.toc) {
    const toc = document.createElement('div');
    toc.className = 'print-toc';
    toc.innerHTML = `<h2>目录</h2>${blocks.filter(b => /^#{1,3}\s/.test(b.raw)).map(b => {
      const depth = b.raw.match(/^#+/)?.[0].length || 1;
      return `<div style="padding-left:${(depth - 1) * 18}px">${esc(b.raw.replace(/^#+\s*/, '').trim())}</div>`;
    }).join('')}`;
    applyChinesePrintFont(toc);
    content.append(toc);
  }
  const nextPage = (line = 0, type = 'automatic') => {
    page = makePage(pages.length + 1, 0, false, currentTemplate);
    host.append(page); pages.push(page);
    content = page.querySelector<HTMLElement>('.print-content')!;
    boundaries.push({ line, page: pages.length, type });
  };
  const contentHeight = () => content.clientHeight;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const desiredTemplate = templateForBlock(blockIndex);
    if (desiredTemplate !== currentTemplate) {
      currentTemplate = desiredTemplate;
      if (content.children.length) nextPage(block.line);
      else setTemplateArtwork(page, currentTemplate);
    }
    if (/^\s*<!--\s*pagebreak\s*-->\s*$/i.test(block.raw)) {
      nextPage(blocks[blockIndex + 1]?.line ?? block.line, 'manual'); continue;
    }
    const element = makePrintBlock(block);
    content.append(element);
    await localizeImages(element);
    await waitImages(element);
    await renderMermaid(element);
    if (content.scrollHeight <= contentHeight() + 2) continue;
    content.removeChild(element);
    const table = element.querySelector('table');
    const rows = table ? [...table.querySelectorAll('tbody tr')] : [];
    const pre = element.querySelector('pre');
    const lines = pre?.textContent?.includes('\n') ? pre.textContent.split('\n') : [];
    const canFlow = rows.length > 1 || lines.length > 1 || (!table && !pre && !!element.querySelector('p, blockquote, li'));
    if (content.children.length && !canFlow) nextPage(block.line);
    content.append(element);
    if (content.scrollHeight <= contentHeight() + 2) continue;
    // Rows of an oversized table can continue on a later page with its header.
    if (rows.length > 1) {
      content.removeChild(element);
      let current: HTMLElement | null = null;
      for (const row of rows) {
        if (!current) {
          current = element.cloneNode(true) as HTMLElement;
          current.querySelector('tbody')!.innerHTML = '';
          content.append(current);
        }
        current.querySelector('tbody')!.append(row.cloneNode(true));
        if (content.scrollHeight > contentHeight() + 2) {
          const currentRows = current.querySelectorAll('tbody tr');
          if (currentRows.length === 1 && content.children.length > 1) {
            current.remove(); nextPage(block.line); content.append(current);
          } else if (currentRows.length > 1) {
            currentRows[currentRows.length - 1].remove();
            nextPage(block.line); current = element.cloneNode(true) as HTMLElement;
            current.querySelector('tbody')!.innerHTML = '';
            current.querySelector('tbody')!.append(row.cloneNode(true));
            content.append(current);
          }
        }
      }
      continue;
    }
    // Long preformatted content is split on lines; the original Markdown remains intact.
    if (lines.length > 1) {
      content.removeChild(element);
      let current: HTMLElement | null = null;
      for (const line of lines) {
        if (!current) {
          current = element.cloneNode(true) as HTMLElement;
          current.querySelector('pre')!.textContent = '';
          content.append(current);
        }
        const currentPre = current.querySelector('pre')!;
        const old = currentPre.textContent || '';
        currentPre.textContent = old + (old ? '\n' : '') + line;
        if (content.scrollHeight > contentHeight() + 2) {
          if (!old && content.children.length > 1) {
            current.remove(); nextPage(block.line); content.append(current);
          } else if (old) {
            currentPre.textContent = old; nextPage(block.line);
            current = element.cloneNode(true) as HTMLElement;
            current.querySelector('pre')!.textContent = line;
            content.append(current);
          }
        }
      }
    } else {
      // Continue text at rendered line boundaries, using any remaining room on this page.
      content.removeChild(element);
      const probe = document.createElement('div');
      probe.className = 'print-fragment';
      probe.style.height = '0';
      const probeClone = element.cloneNode(true) as HTMLElement;
      probeClone.style.position = 'absolute'; probeClone.style.top = '0'; probeClone.style.left = '0'; probeClone.style.width = '100%';
      probe.append(probeClone); content.append(probe);
      const lineBottoms = textLineBottoms(probeClone);
      const fullHeight = Math.max(probeClone.getBoundingClientRect().height, (lineBottoms.at(-1) || 0) + 2);
      probe.remove();
      let offset = 0;
      while (offset < fullHeight - 1) {
        const last = content.lastElementChild as HTMLElement | null;
        const occupied = last ? last.getBoundingClientRect().bottom - content.getBoundingClientRect().top : 0;
        const available = contentHeight() - occupied;
        const nextLine = lineBottoms.find(bottom => bottom > offset + 1);
        if (available < (nextLine ? nextLine - offset + 1 : 1)) { nextPage(block.line); continue; }
        let height = Math.min(available, fullHeight - offset);
        let nextOffset = offset + height;
        if (nextOffset < fullHeight - 1 && lineBottoms.length) {
          const lastLine = lineBottoms.filter(bottom => bottom > offset + 1 && bottom <= nextOffset - 2).at(-1);
          if (!lastLine) {
            if (content.children.length) { nextPage(block.line); continue; }
          } else {
            nextOffset = lastLine >= lineBottoms.at(-1)! - 1 ? fullHeight : lastLine + 1;
            height = Math.min(available, nextOffset - offset);
          }
        }
        const fragment = document.createElement('div');
        fragment.className = 'print-fragment';
        fragment.style.height = `${height}px`;
        const clone = element.cloneNode(true) as HTMLElement;
        clone.style.position = 'absolute'; clone.style.top = `-${offset}px`; clone.style.left = '0'; clone.style.width = '100%';
        fragment.append(clone); content.append(fragment);
        offset = nextOffset;
        if (offset < fullHeight - 1) nextPage(block.line);
      }
    }
  }
  pages.forEach((item, i) => {
    const number = item.querySelector('.print-page-number');
    if (number && exportSettings.pageNumbers) {
      number.textContent = exportSettings.pageNumberFormat === 'number' ? String(i + 1) : `${i + 1} / ${pages.length}`;
    }
  });
  pageBoundaries = boundaries;
  markPageBoundaries();
  post('pageBoundaries', { boundaries: showBreaks ? boundaries : [] });
  return pages;
}
function markPageBoundaries() {
  document.querySelectorAll('#documentBody .page-boundary').forEach(el => el.remove());
  if (!showBreaks) return;
  const blockElements = [...document.querySelectorAll<HTMLElement>('#documentBody .md-block')];
  for (const boundary of pageBoundaries) {
    const target = blockElements.find(el => Number(el.dataset.line) >= boundary.line) || blockElements.at(-1);
    if (!target) continue;
    const marker = document.createElement('div');
    marker.className = `page-boundary ${boundary.type}`;
    marker.textContent = `第 ${boundary.page} 页 · ${boundary.type === 'manual' ? '手动分页' : '自动分页'}`;
    target.before(marker);
  }
}
function schedulePdf(force = false) {
  if (!(mode === 'pdf' || visualPdf || force || autoExport)) return;
  if (!autoUpdate && !force && !autoExport) return;
  window.clearTimeout(pdfTimer);
  pdfTimer = window.setTimeout(() => void generatePdf(), force ? 0 : 900);
}
// html2canvas clones the document into an iframe. In VS Code webviews, linked CSS can fail
// to load there, so preserve the computed print layout on the captured nodes themselves.
const printStyleProperties = [
  'display','position','top','right','bottom','left','width','height','min-width','max-width','min-height','max-height',
  'box-sizing','overflow','overflow-x','overflow-y','visibility','opacity','z-index','transform','transform-origin',
  'margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left',
  'border-top-width','border-right-width','border-bottom-width','border-left-width',
  'border-top-style','border-right-style','border-bottom-style','border-left-style',
  'border-top-color','border-right-color','border-bottom-color','border-left-color','border-radius',
  'background-color','background-image','background-position','background-size','background-repeat','box-shadow',
  'color','font-family','font-size','font-weight','font-style','font-variant','line-height','letter-spacing','word-spacing',
  'text-align','text-decoration-line','text-decoration-color','text-decoration-style','text-transform','text-indent',
  'text-shadow','white-space','overflow-wrap','word-break','vertical-align','object-fit',
  'border-collapse','border-spacing','table-layout','list-style-type','direction'
];
function freezePrintStyles(page: HTMLElement) {
  const elements = [page, ...page.querySelectorAll<HTMLElement>('*')];
  const snapshots = elements.map(element => {
    const computed = getComputedStyle(element);
    return printStyleProperties.map(property => computed.getPropertyValue(property));
  });
  elements.forEach((element, index) => printStyleProperties.forEach((property, propertyIndex) => {
    const value = snapshots[index][propertyIndex];
    if (value) element.style.setProperty(property, value);
  }));
}
async function generatePdf() {
  if (pdfBusy) { pdfQueued = true; return; }
  pdfBusy = true; pdfQueued = false;
  const generationKey = JSON.stringify([version, exportSettings, settings.editorFontFamily]);
  const status = document.getElementById('pdfStatus');
  if (status) status.textContent = '正在生成 PDF…';
  toast('正在生成 PDF…');
  try {
    await fontsReady;
    await document.fonts.ready;
    const pages = await paginate();
    await document.fonts.ready;
    await waitImages(document.getElementById('printHost')!);
    const [width, height] = paperSize();
    const pdf = new jsPDF({ orientation: exportSettings.orientation, unit: 'mm', format: [width, height], compress: true });
    const previewImages: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      if (i) pdf.addPage([width, height], exportSettings.orientation);
      if (status) status.textContent = `正在生成 PDF：${i + 1} / ${pages.length}`;
      const page = pages[i];
      freezePrintStyles(page);
      const canvas = await html2canvas(page, { scale: 2, useCORS: true, allowTaint: false, backgroundColor: '#fff', logging: false,
        width: page.offsetWidth, height: page.offsetHeight, windowWidth: page.offsetWidth, windowHeight: page.offsetHeight });
      const image = canvas.toDataURL('image/png');
      previewImages.push(image);
      pdf.addImage(image, 'PNG', 0, 0, width, height, undefined, 'FAST');
      // Keep links clickable even though the page artwork is rasterized.
      for (const link of page.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const href = link.getAttribute('href') || '';
        if (!/^(https?:|mailto:)/i.test(href)) continue;
        const rect = link.getBoundingClientRect(), pageRect = page.getBoundingClientRect();
        pdf.link((rect.left - pageRect.left) * width / pageRect.width, (rect.top - pageRect.top) * height / pageRect.height,
          rect.width * width / pageRect.width, rect.height * height / pageRect.height, { url: href });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (generationKey !== JSON.stringify([version, exportSettings, settings.editorFontFamily])) {
      pdfQueued = true;
      if (status) status.textContent = '文档已变化，正在重新生成 PDF…';
      return;
    }
    pdfBytes = new Uint8Array(pdf.output('arraybuffer'));
    pdfDirty = false;
    pdfPreviewImages = previewImages;
    pdfPreviewSize = [width, height];
    await renderPdfPages();
    const missingImages = document.querySelectorAll('#printHost .print-content img.missing-image').length;
    const message = `PDF 已更新 · ${pages.length} 页${missingImages ? ` · ${missingImages} 张图片加载失败` : ''}`;
    if (status) status.textContent = message;
    toast(message, !!missingImages);
    if (autoExport) { autoExport = false; sendPdfBytes(); }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (status) status.textContent = `PDF 生成失败：${detail}`;
    toast(`PDF 生成失败：${detail}`, true);
  } finally {
    pdfBusy = false;
    if (pdfQueued) schedulePdf(true);
  }
}
async function renderPdfPages() {
  const container = document.getElementById('pdfPages');
  if (!container || !pdfPreviewImages.length) return;
  pdfObserver?.disconnect();
  const token = ++pdfRenderToken;
  const previous = pdfPage;
  container.innerHTML = '';
  pdfObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting)
      void renderPdfSlot(entry.target as HTMLElement, token);
  }, { root: container, rootMargin: '700px 0px' });
  for (let i = 1; i <= pdfPreviewImages.length; i++) {
    const slot = document.createElement('div');
    slot.className = 'pdf-page-slot'; slot.dataset.page = String(i);
    slot.style.width = `${Math.ceil(pdfPreviewSize[0] * 72 / 25.4 * pdfScale)}px`;
    slot.style.height = `${Math.ceil(pdfPreviewSize[1] * 72 / 25.4 * pdfScale)}px`;
    container.append(slot); pdfObserver.observe(slot);
  }
  jumpPage(Math.min(previous, pdfPreviewImages.length));
  const first = container.querySelector<HTMLElement>('.pdf-page-slot');
  if (first) await renderPdfSlot(first, token);
  updatePageInfo();
}
async function renderPdfSlot(slot: HTMLElement, token: number) {
  if (slot.dataset.rendering || slot.querySelector('canvas') || token !== pdfRenderToken) return;
  slot.dataset.rendering = 'true';
  try {
    const image = new Image();
    image.src = pdfPreviewImages[Number(slot.dataset.page) - 1];
    await image.decode();
    if (token !== pdfRenderToken) return;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.style.width = slot.style.width; canvas.style.height = slot.style.height;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    slot.append(canvas);
  } catch (error) {
    if (token === pdfRenderToken) slot.textContent = `页面渲染失败：${error instanceof Error ? error.message : error}`;
  } finally { delete slot.dataset.rendering; }
}
function updatePageInfo() {
  const info = document.getElementById('pageInfo');
  if (info) info.textContent = `${pdfPage} / ${pdfPreviewImages.length}`;
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = `${Math.round(pdfScale * 100)}%`;
}
function jumpPage(page: number) {
  if (!pdfPreviewImages.length) return;
  pdfPage = Math.max(1, Math.min(pdfPreviewImages.length, page));
  document.querySelector(`#pdfPages .pdf-page-slot[data-page="${pdfPage}"]`)?.scrollIntoView({ block: 'start' });
  updatePageInfo();
}
function setScale(value: number) {
  pdfScale = Math.max(0.3, Math.min(3, value));
  void renderPdfPages();
}
async function exportPdf() {
  if (!pdfBytes || pdfBusy || pdfDirty) {
    autoExport = true; schedulePdf(true); return;
  }
  sendPdfBytes();
}
function sendPdfBytes() {
  if (!pdfBytes) return;
  toast('正在保存 PDF…');
  const bytes = pdfBytes;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  post('savePdf', { data: btoa(binary) });
}
function setFonts(items: any[], importedId?: string) {
  fonts = items.filter(font => /^[a-z0-9-]+$/i.test(font.family) && typeof font.url === 'string');
  let style = document.getElementById('importedFontsStyle') as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = 'importedFontsStyle'; document.head.append(style); }
  style.textContent = fonts.map(font => `@font-face{font-family:${font.family};src:url(${JSON.stringify(font.url)});font-display:block}`).join('\n');
  fontsReady = Promise.all(fonts.map(async font => {
    try {
      await document.fonts.load(`16px ${font.family}`);
    } catch { toast(`字体无法加载：${font.name}`, true); }
  })).then(() => {});
  const dialog = document.getElementById('dialogBackdrop');
  if (dialog && !dialog.classList.contains('hidden') && document.getElementById('set-fontFamily')) {
    for (const key of ['fontFamily', 'titleFontFamily']) {
      const select = document.getElementById('set-' + key) as HTMLSelectElement;
      const previous = select.value;
      const options = [{ family: '', name: '默认（中文宋体，英文跟随编辑器）' }, ...fonts];
      if (previous && !options.some(font => font.family === previous)) options.push({ family: previous, name: previous });
      select.innerHTML = options.map(font =>
        `<option value="${esc(font.family)}">${esc(font.name)}</option>`).join('');
      select.value = key === 'fontFamily' && importedId ? fonts.find(font => font.id === importedId)?.family || previous : previous;
    }
  }
  void fontsReady.then(() => { pdfDirty = true; schedulePdf(); });
}
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message.type === 'imageResolved') {
    const request = pendingImageRequests.get(message.id);
    if (!request) return;
    pendingImageRequests.delete(message.id);
    window.clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.data);
  } else if (message.type === 'document') {
    settings = message.settings || {}; exportSettings = { ...exportSettings, ...(message.exportSettings || {}) };
    if (exportSettings.fontFamily === 'Arial, sans-serif') exportSettings.fontFamily = '';
    if (exportSettings.titleFontFamily === 'Georgia, serif') exportSettings.titleFontFamily = '';
    normalizeExportSettings();
    templates = message.templates || []; setFonts(message.fonts || []); autoUpdate = settings.autoUpdate !== false;
    autoExport = !!message.autoExport;
    source = message.source; version = message.version; pdfDirty = true; renderDocument(false);
    if (mode === 'pdf' || autoExport) schedulePdf(true);
  } else if (message.type === 'documentChanged') {
    if (pendingEdit && message.source === pendingEdit.nextSource) {
      applySource(message.source, message.version, true);
    } else applySource(message.source, message.version);
  } else if (message.type === 'editAck') {
    const before = ownEdits.get(message.id);
    ownEdits.delete(message.id);
    if (before !== undefined && before !== message.source && !historyDirection) {
      editHistory.push({ before, after: message.source });
      if (editHistory.length > 100) editHistory.shift();
      redoHistory = [];
    }
    if (historyDirection) historyDirection = null;
    if (pendingEdit?.id === message.id) applySource(message.source, message.version, true);
    else applySource(message.source, message.version);
    if (queuedHistory) { const direction = queuedHistory; queuedHistory = null; changeHistory(direction); }
    if (saveQueued) flushQueuedSave();
    else toast('Markdown 已同步');
  } else if (message.type === 'conflict') {
    pendingEdit = null; ownEdits.clear(); editHistory = []; redoHistory = []; queuedHistory = null; historyDirection = null; saveQueued = false;
    applySource(message.source, message.version); toast('文件已在其他位置修改，页面已更新', true);
  } else if (message.type === 'settings') {
    settings = message.value; pdfDirty = true; renderDocument(); schedulePdf();
  } else if (message.type === 'exportSettings') {
    exportSettings = { ...exportSettings, ...message.value }; normalizeExportSettings(); pdfDirty = true; schedulePdf();
  } else if (message.type === 'templates') {
    templates = message.templates;
    if (message.importedId && templateImportDraft) { templateImportDraft = null; settingsDialog(); }
    const list = document.querySelector<HTMLElement>('.template-settings .template-list');
    if (list) {
      list.innerHTML = templateOptions();
      if (message.importedId) {
        const selected = [...list.querySelectorAll<HTMLInputElement>('input[name="template"]')].find(input => input.value === message.importedId);
        if (selected) selected.checked = true;
        updateVariantSelectors();
      }
      updateMarginSheet(); updateCoverSheet();
    }
  } else if (message.type === 'templateImagePicked') {
    if (templateImportDraft) {
      templateImportDraft.slots[message.slot] = { name: message.name, url: message.url };
      templateImportDialog();
    }
  } else if (message.type === 'fonts') {
    setFonts(message.fonts || [], message.importedId);
  } else if (message.type === 'scrollToLine') {
    if (mode === 'preview') { lastScrollLine = message.line; scrollToLine(message.line); }
  } else if (message.type === 'showPdf') {
    visualPdf = true; document.getElementById('workspace')!.classList.add('with-pdf'); updatePdfActions(); schedulePdf(true);
  } else if (message.type === 'exportNow') {
    void exportPdf();
  } else if (message.type === 'saveResult') toast(message.success ? 'Markdown 已保存' : 'Markdown 保存失败', !message.success);
  else if (message.type === 'error') toast(message.detail, true);
  else if (message.type === 'exportResult') toast(message.cancelled ? '已取消导出' : message.success ? 'PDF 已导出' : '导出失败', !message.success && !message.cancelled);
});
buildShell();
post('ready');
