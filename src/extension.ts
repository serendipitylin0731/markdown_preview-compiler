import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { imageDataUrl } from './image-source';

type Mode = 'preview' | 'visual' | 'pdf';
type Panel = { panel: vscode.WebviewPanel; uri: vscode.Uri; mode: Mode; autoExport?: boolean; exportSettings?: Record<string, any> };
const panels = new Set<Panel>();
const templateDrafts = new Map<Panel, Record<string, { file: string; name: string }>>();
const templateSlotPattern = /^(a4|a5|letter)-(portrait|landscape)-(body|cover)$/;
const boundariesByUri = new Map<string, Array<{ line: number; page: number; type: string }>>();
const editorViewportByUri = new Map<string, string>();
const previewScrollEchoByUri = new Map<string, number>();
let boundaryDecoration: vscode.TextEditorDecorationType;
let lastDocument: vscode.Uri | undefined;
let extensionContext: vscode.ExtensionContext;

function settings(uri?: vscode.Uri) {
  const scope = uri ? { uri, languageId: 'markdown' } : undefined;
  const c = vscode.workspace.getConfiguration('markdownCompiler', scope);
  const editorFontFamily = vscode.workspace.getConfiguration('editor', scope).get<string>('fontFamily', 'monospace');
  const previewFontFamily = c.get<string>('preview.fontFamily', '').trim();
  return {
    fontFamily: previewFontFamily || editorFontFamily,
    editorFontFamily,
    fontSize: c.get<number>('preview.fontSize', 16),
    lineHeight: c.get<number>('preview.lineHeight', 1.6),
    paragraphGap: c.get<number>('preview.paragraphGap', 10),
    maxWidth: c.get<number>('preview.maxWidth', 860),
    syncScroll: c.get<boolean>('preview.syncScroll', true),
    autoUpdate: c.get<boolean>('pdf.autoUpdate', true)
  };
}

function relevantDocument(): vscode.TextDocument | undefined {
  const activePanel = [...panels].find(state => state.panel.active);
  if (activePanel) {
    const match = vscode.workspace.textDocuments.find(d => d.uri.toString() === activePanel.uri.toString());
    if (match) return match;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === 'markdown') return editor.document;
  if (lastDocument) return vscode.workspace.textDocuments.find(d => d.uri.toString() === lastDocument!.toString());
  return vscode.workspace.textDocuments.find(d => d.languageId === 'markdown');
}

async function currentDocument(): Promise<vscode.TextDocument | undefined> {
  const document = relevantDocument();
  if (document) { lastDocument = document.uri; return document; }
  const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Markdown: ['md', 'markdown', 'mdown'] } });
  if (!file?.[0]) return;
  lastDocument = file[0];
  return vscode.workspace.openTextDocument(file[0]);
}

function webviewHtml(webview: vscode.Webview, document: vscode.TextDocument, mode: Mode): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'katex.min.css'));
  const appCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview.css'));
  const directory = webview.asWebviewUri(vscode.Uri.joinPath(document.uri, '..')).toString();
  const sjtuBackgrounds = ['red', 'blue'].flatMap(color =>
    ['a4', 'a5', 'letter'].flatMap(paper =>
      ['portrait', 'landscape'].flatMap(orientation =>
        [false, true].map(cover => `sjtu-${color}-${paper}-${orientation}${cover ? '-cover' : ''}`))));
  const templateUrls = Object.fromEntries([...['simple', 'academic', 'technical', 'cover'], ...sjtuBackgrounds].map(name =>
    [name, webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'assets', 'templates', `${name}.${name.startsWith('sjtu-') ? 'png' : 'svg'}`)).toString()]));
  const boot = JSON.stringify({ mode, directory, templateUrls }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' blob:; worker-src blob: ${webview.cspSource}; connect-src ${webview.cspSource} data: blob: https:;">
<link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${appCss}"><title>Markdown Compiler</title></head><body>
<div id="app"></div><script nonce="${nonce}">window.__MDC_BOOT__=${boot};</script><script src="${script}"></script>
</body></html>`;
}

function panelTitle(document: vscode.TextDocument, mode: Mode) {
  return `${path.basename(document.uri.fsPath)} · ${mode === 'visual' ? '预览编辑' : mode === 'pdf' ? 'PDF 预览' : '预览'}`;
}

async function openPanel(document: vscode.TextDocument, mode: Mode, column: vscode.ViewColumn, autoExport = false) {
  lastDocument = document.uri;
  const existing = [...panels].find(p => p.uri.toString() === document.uri.toString());
  if (existing) {
    if (existing.mode !== mode) {
      existing.mode = mode;
      existing.autoExport = autoExport;
      existing.panel.title = panelTitle(document, mode);
      existing.panel.webview.html = webviewHtml(existing.panel.webview, document, mode);
    } else if (autoExport) post(existing, { type: 'exportNow' });
    existing.panel.reveal(mode === 'preview' ? vscode.ViewColumn.Two : undefined);
    return existing;
  }
  const panel = vscode.window.createWebviewPanel('markdownCompiler', panelTitle(document, mode), column, {
    enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [extensionContext.extensionUri, vscode.Uri.joinPath(document.uri, '..'), extensionContext.globalStorageUri]
  });
  const state: Panel = { panel, uri: document.uri, mode, autoExport };
  panels.add(state);
  panel.webview.html = webviewHtml(panel.webview, document, mode);
  panel.onDidDispose(() => {
    panels.delete(state);
    void discardTemplateDraft(state);
    if (![...panels].some(other => other.uri.toString() === state.uri.toString())) {
      boundariesByUri.delete(state.uri.toString());
      editorViewportByUri.delete(state.uri.toString());
      previewScrollEchoByUri.delete(state.uri.toString());
      refreshBoundaryDecorations();
    }
  });
  panel.webview.onDidReceiveMessage(message => handleMessage(state, message));
  return state;
}

function post(state: Panel, message: unknown) { void state.panel.webview.postMessage(message); }
function cursorFor(uri: vscode.Uri) {
  const editor = vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === uri.toString());
  const position = editor?.selection?.active;
  return position ? { line: position.line, character: position.character } : undefined;
}
function visiblePositionFor(uri: vscode.Uri) {
  const editor = vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === uri.toString());
  const start = editor?.visibleRanges?.[0]?.start;
  return start ? { line: start.line, character: start.character } : undefined;
}
function syncEditorViewport(editor: vscode.TextEditor, ranges: readonly vscode.Range[], onlyIfChanged = false) {
  if (!settings(editor.document.uri).syncScroll) return;
  const start = ranges[0]?.start;
  if (!start || !Number.isInteger(start.line)) return;
  const key = editor.document.uri.toString();
  const position = `${start.line}:${start.character}`;
  if (Date.now() < (previewScrollEchoByUri.get(key) || 0)) {
    editorViewportByUri.set(key, position);
    return;
  }
  if (onlyIfChanged && editorViewportByUri.get(key) === position) return;
  editorViewportByUri.set(key, position);
  for (const state of panels) if (state.mode === 'preview' && state.uri.toString() === key)
    post(state, { type: 'scrollToLine', line: start.line, character: start.character });
}
function pdfLayoutKey(uri: vscode.Uri) { return `pdfLayout:${uri.toString()}`; }
function templatesFor(state: Panel) {
  return extensionContext.globalState.get<any[]>('templates', []).map(template => ({
    id: template.id, name: template.name,
    ...(template.file ? { url: templateUrl(state, template.file), coverUrl: template.coverFile ? templateUrl(state, template.coverFile) : undefined } : {}),
    ...(template.variants ? { variants: Object.fromEntries(Object.entries(template.variants).map(([key, variant]: [string, any]) => [key, {
      bodyUrl: variant.body ? templateUrl(state, variant.body) : undefined,
      coverUrl: variant.cover ? templateUrl(state, variant.cover) : undefined
    }])) } : {})
  }));
}
function templateUrl(state: Panel, file: string) {
  return state.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.globalStorageUri, file)).toString();
}
async function discardTemplateDraft(state: Panel) {
  const draft = templateDrafts.get(state);
  templateDrafts.delete(state);
  if (!draft) return;
  for (const entry of Object.values(draft)) {
    try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(extensionContext.globalStorageUri, entry.file)); } catch { /* already removed */ }
  }
}
function fontsFor(state: Panel) {
  return extensionContext.globalState.get<any[]>('fonts', []).map(font => ({
    id: font.id, name: font.name, family: font.family,
    url: state.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.globalStorageUri, 'fonts', font.file)).toString()
  }));
}
function refreshBoundaryDecorations() {
  for (const editor of vscode.window.visibleTextEditors) {
    const entries = boundariesByUri.get(editor.document.uri.toString()) || [];
    const decorations: vscode.DecorationOptions[] = entries
      .filter(item => Number.isInteger(item.line) && item.line >= 0 && item.line < editor.document.lineCount)
      .map(item => ({
        range: new vscode.Range(item.line, 0, item.line, 0),
        renderOptions: { before: {
          contentText: `第 ${item.page} 页 · ${item.type === 'manual' ? '手动分页' : '自动分页'}  `,
          color: item.type === 'manual' ? '#a5691d' : '#6680a1',
          margin: '0 8px 0 0'
        } }
      }));
    editor.setDecorations(boundaryDecoration, decorations);
  }
}

async function handleMessage(state: Panel, message: any) {
  if (message.type === 'scrollTo') {
    const editor = vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === state.uri.toString());
    if (state.mode === 'preview' && settings(state.uri).syncScroll && editor &&
        Number.isInteger(message.line) && message.line >= 0 && message.line < editor.document.lineCount &&
        editor.visibleRanges[0]?.start.line !== message.line) {
      previewScrollEchoByUri.set(state.uri.toString(), Date.now() + 300);
      editor.revealRange(new vscode.Range(message.line, 0, message.line, 0), vscode.TextEditorRevealType.AtTop);
    }
    return;
  }
  const document = await vscode.workspace.openTextDocument(state.uri);
  try {
    if (message.type === 'ready') {
      post(state, { type: 'document', source: document.getText(), version: document.version, settings: settings(document.uri),
        exportSettings: state.exportSettings || extensionContext.globalState.get<Record<string, any>>(pdfLayoutKey(state.uri), {}),
        templates: templatesFor(state), fonts: fontsFor(state),
        autoExport: state.autoExport, cursor: cursorFor(state.uri), visiblePosition: visiblePositionFor(state.uri) });
      state.autoExport = false;
    } else if (message.type === 'resolveImage') {
      const id = String(message.id || '');
      if (!/^[a-z0-9]+-\d+$/.test(id)) return;
      try {
        const data = await imageDataUrl(String(message.source || ''), async source => {
          const target = /^file:/i.test(source) ? vscode.Uri.parse(source) :
            vscode.Uri.joinPath(document.uri, '..', decodeURIComponent(source.split(/[?#]/, 1)[0]));
          return vscode.workspace.fs.readFile(target);
        }, vscode.workspace.getConfiguration('http').get<string>('proxy') || '');
        post(state, { type: 'imageResolved', id, data });
      } catch (error) {
        post(state, { type: 'imageResolved', id, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (message.type === 'edit') {
      const { start, end, expected, replacement } = message;
      if (![start, end].every(Number.isInteger) || start < 0 || end < start || end > document.getText().length ||
          document.getText().slice(start, end) !== expected || typeof replacement !== 'string') {
        post(state, { type: 'conflict', source: document.getText(), version: document.version });
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), replacement);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('无法应用 Markdown 修改');
      post(state, { type: 'editAck', id: message.id, source: document.getText(), version: document.version,
        start, end: start + replacement.length });
    } else if (message.type === 'source') {
      for (const other of [...panels]) if (other.uri.toString() === document.uri.toString()) other.panel.dispose();
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      await extensionContext.globalState.update('lastMode', 'source');
    } else if (message.type === 'split') {
      await showSplit(document);
    } else if (message.type === 'visual') {
      await openPanel(document, 'visual', vscode.ViewColumn.One);
      await extensionContext.globalState.update('lastMode', 'visual');
    } else if (message.type === 'pdf') {
      await showPdf(document);
    } else if (message.type === 'saveSettings') {
      state.exportSettings = { ...message.value };
      await extensionContext.globalState.update(pdfLayoutKey(state.uri), state.exportSettings);
      for (const other of panels) if (other !== state && other.uri.toString() === document.uri.toString()) {
        other.exportSettings = state.exportSettings;
        post(other, { type: 'exportSettings', value: state.exportSettings });
      }
    } else if (message.type === 'saveDocument') {
      const saved = await document.save();
      post(state, { type: 'saveResult', success: saved });
    } else if (message.type === 'savePdf') {
      const name = path.basename(document.uri.fsPath).replace(/\.(md|markdown|mdown)$/i, '') + '.pdf';
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(document.uri, '..', name), filters: { PDF: ['pdf'] } });
      if (!target) { post(state, { type: 'exportResult', success: false, cancelled: true }); return; }
      const bytes = Uint8Array.from(Buffer.from(message.data, 'base64'));
      await vscode.workspace.fs.writeFile(target, bytes);
      post(state, { type: 'exportResult', success: true, path: target.fsPath });
      const action = await vscode.window.showInformationMessage(`PDF 已导出：${target.fsPath}`, '打开 PDF');
      if (action === '打开 PDF') await vscode.env.openExternal(target);
    } else if (message.type === 'pickTemplateImage') {
      const slot = String(message.slot || '');
      if (!templateSlotPattern.test(slot)) throw new Error('无效的模板位置');
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: `选择${slot.endsWith('body') ? '内页' : '封面'}图片`, filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'svg'] } });
      if (!files?.[0]) return;
      const bytes = await vscode.workspace.fs.readFile(files[0]);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('模板图片不能超过 20 MB');
      const ext = path.extname(files[0].fsPath).toLowerCase();
      await vscode.workspace.fs.createDirectory(extensionContext.globalStorageUri);
      const draft = templateDrafts.get(state) || {};
      if (draft[slot]) try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(extensionContext.globalStorageUri, draft[slot].file)); } catch { /* already removed */ }
      const file = `template-draft-${crypto.randomUUID()}${ext}`;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extensionContext.globalStorageUri, file), bytes);
      draft[slot] = { file, name: path.basename(files[0].fsPath) };
      templateDrafts.set(state, draft);
      post(state, { type: 'templateImagePicked', slot, name: draft[slot].name, url: templateUrl(state, file) });
    } else if (message.type === 'removeTemplateImage') {
      const slot = String(message.slot || '');
      const draft = templateDrafts.get(state);
      if (templateSlotPattern.test(slot) && draft?.[slot]) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(extensionContext.globalStorageUri, draft[slot].file));
        delete draft[slot];
      }
    } else if (message.type === 'discardTemplateDraft') {
      await discardTemplateDraft(state);
    } else if (message.type === 'saveTemplateImport') {
      const draft = templateDrafts.get(state) || {};
      const name = String(message.name || '').trim();
      if (!name || name.length > 80) throw new Error('请填写 1–80 字的模板名称');
      if (!Object.keys(draft).some(slot => slot.endsWith('-body'))) throw new Error('至少需要导入一张内页图片');
      if (Object.keys(draft).some(slot => slot.endsWith('-cover') && !draft[slot.replace(/-cover$/, '-body')]))
        throw new Error('每张封面都需要同尺寸、同方向的内页图片');
      const id = crypto.randomUUID();
      const variants: Record<string, { body?: string; cover?: string }> = {};
      for (const [slot, entry] of Object.entries(draft)) {
        const [paper, orientation, kind] = slot.split('-');
        const key = `${paper}-${orientation}`;
        const file = `template-${id}-${slot}${path.extname(entry.file)}`;
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extensionContext.globalStorageUri, file),
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionContext.globalStorageUri, entry.file)));
        (variants[key] ||= {})[kind as 'body' | 'cover'] = file;
      }
      const templates = extensionContext.globalState.get<any[]>('templates', []);
      templates.push({ id, name, variants });
      await extensionContext.globalState.update('templates', templates);
      await discardTemplateDraft(state);
      for (const other of panels) post(other, { type: 'templates', templates: templatesFor(other), importedId: other === state ? id : undefined });
    } else if (message.type === 'importFont') {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Fonts: ['ttf', 'otf', 'woff', 'woff2'] } });
      if (!files?.[0]) return;
      const bytes = await vscode.workspace.fs.readFile(files[0]);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('字体文件不能超过 20 MB');
      const ext = path.extname(files[0].fsPath).toLowerCase();
      const signature = Buffer.from(bytes.subarray(0, 4)).toString('latin1');
      const valid = ext === '.ttf' ? (signature === '\x00\x01\x00\x00' || signature === 'true') :
        ext === '.otf' ? signature === 'OTTO' : ext === '.woff' ? signature === 'wOFF' : ext === '.woff2' && signature === 'wOF2';
      if (!valid) throw new Error('字体格式与文件扩展名不匹配');
      const id = crypto.randomUUID();
      const font = { id, name: path.basename(files[0].fsPath), family: `mdc-font-${id}`, file: `${id}${ext}` };
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(extensionContext.globalStorageUri, 'fonts'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extensionContext.globalStorageUri, 'fonts', font.file), bytes);
      const fonts = extensionContext.globalState.get<any[]>('fonts', []);
      fonts.push(font);
      await extensionContext.globalState.update('fonts', fonts);
      for (const other of panels) post(other, { type: 'fonts', fonts: fontsFor(other), importedId: other === state ? id : undefined });
    } else if (message.type === 'exportTemplate') {
      const template = extensionContext.globalState.get<any[]>('templates', []).find(t => t.id === message.id);
      if (!template) return;
      const variant = template.variants?.[`${message.paper}-${message.orientation}`]
        || Object.values(template.variants || {}).find((entry: any) => entry.body);
      const file = template.file || variant?.body;
      if (!file) throw new Error('模板文件不存在');
      const source = vscode.Uri.joinPath(extensionContext.globalStorageUri, file);
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), template.name + path.extname(file))) });
      if (target) await vscode.workspace.fs.writeFile(target, await vscode.workspace.fs.readFile(source));
    } else if (message.type === 'openLink') {
      const uri = vscode.Uri.parse(message.url);
      if (uri.scheme === 'https' || uri.scheme === 'http' || uri.scheme === 'mailto') await vscode.env.openExternal(uri);
    } else if (message.type === 'openLocalLink') {
      const href = String(message.href || '');
      if (href && !href.startsWith('//') && !/^[a-z][\w+.-]*:/i.test(href)) {
        const target = vscode.Uri.joinPath(document.uri, '..', decodeURIComponent(href.split('#')[0]));
        await vscode.commands.executeCommand('vscode.open', target);
      }
    } else if (message.type === 'pageBoundaries') {
      boundariesByUri.set(state.uri.toString(), Array.isArray(message.boundaries) ? message.boundaries : []);
      refreshBoundaryDecorations();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    post(state, { type: 'error', detail });
    void vscode.window.showErrorMessage(`Markdown Compiler: ${detail}`);
  }
}

async function showSplit(document: vscode.TextDocument) {
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  await openPanel(document, 'preview', vscode.ViewColumn.Two);
  await extensionContext.globalState.update('lastMode', 'split');
}

async function showPdf(document: vscode.TextDocument) {
  const existing = [...panels].find(p => p.uri.toString() === document.uri.toString());
  if (!existing) await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  await openPanel(document, 'pdf', existing?.panel.viewColumn || vscode.ViewColumn.Two);
  await extensionContext.globalState.update('lastMode', 'pdf');
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  boundaryDecoration = vscode.window.createTextEditorDecorationType({});
  // Visible-range notifications may be missed while focus changes between the editor
  // and its webview. Check the small viewport state as a fallback while split preview is open.
  const viewportTimer = setInterval(() => {
    if (![...panels].some(state => state.mode === 'preview' && state.panel.visible)) return;
    for (const editor of vscode.window.visibleTextEditors)
      syncEditorViewport(editor, editor.visibleRanges, true);
  }, 150);
  viewportTimer.unref();
  context.subscriptions.push(
    boundaryDecoration,
    { dispose: () => clearInterval(viewportTimer) },
    vscode.commands.registerCommand('markdownCompiler.openPreferred', async () => {
      const document = await currentDocument();
      if (!document) return;
      const preferred = context.globalState.get<string>('lastMode', 'split');
      if (preferred === 'visual') {
        await openPanel(document, 'visual', vscode.ViewColumn.One);
      }
      else if (preferred === 'pdf') await showPdf(document);
      else if (preferred === 'source') {
        for (const state of [...panels]) if (state.uri.toString() === document.uri.toString()) state.panel.dispose();
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      }
      else await showSplit(document);
    }),
    vscode.commands.registerCommand('markdownCompiler.source', async () => {
      const document = await currentDocument(); if (document) {
        for (const state of [...panels]) if (state.uri.toString() === document.uri.toString()) state.panel.dispose();
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
        await context.globalState.update('lastMode', 'source');
      }
    }),
    vscode.commands.registerCommand('markdownCompiler.split', async () => {
      const document = await currentDocument(); if (document) await showSplit(document);
    }),
    vscode.commands.registerCommand('markdownCompiler.visual', async () => {
      const document = await currentDocument(); if (document) {
        await openPanel(document, 'visual', vscode.ViewColumn.One);
        await context.globalState.update('lastMode', 'visual');
      }
    }),
    vscode.commands.registerCommand('markdownCompiler.pdf', async () => {
      const document = await currentDocument(); if (document) await showPdf(document);
    }),
    vscode.commands.registerCommand('markdownCompiler.export', async () => {
      const document = await currentDocument(); if (document) {
        await openPanel(document, 'pdf', vscode.ViewColumn.Beside, true);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const active = vscode.window.activeTextEditor;
      const typing = active?.document.uri.toString() === event.document.uri.toString() && !!event.contentChanges.length;
      for (const state of panels) if (state.uri.toString() === event.document.uri.toString())
        post(state, { type: 'documentChanged', source: event.document.getText(), version: event.document.version,
          cursor: cursorFor(state.uri), followCursor: typing });
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => {
      syncEditorViewport(event.textEditor, event.visibleRanges);
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      syncEditorViewport(event.textEditor, event.textEditor.visibleRanges, true);
      const position = event.selections[0]?.active;
      if (!position || !settings(event.textEditor.document.uri).syncScroll) return;
      for (const state of panels) if (state.mode === 'preview' &&
          state.uri.toString() === event.textEditor.document.uri.toString())
        post(state, { type: 'cursorPosition', line: position.line, character: position.character });
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('markdownCompiler') || event.affectsConfiguration('editor.fontFamily'))
        for (const state of panels) post(state, { type: 'settings', value: settings(state.uri) });
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshBoundaryDecorations()),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.languageId === 'markdown') lastDocument = editor.document.uri;
    })
  );
}

export function deactivate() {}
