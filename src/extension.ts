import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

type Mode = 'preview' | 'visual' | 'pdf';
type Panel = { panel: vscode.WebviewPanel; uri: vscode.Uri; mode: Mode; autoExport?: boolean };
const panels = new Set<Panel>();
const boundariesByUri = new Map<string, Array<{ line: number; page: number; type: string }>>();
let boundaryDecoration: vscode.TextEditorDecorationType;
let lastDocument: vscode.Uri | undefined;
let extensionContext: vscode.ExtensionContext;

function settings() {
  const c = vscode.workspace.getConfiguration('markdownCompiler');
  return {
    fontFamily: c.get<string>('preview.fontFamily', 'system-ui, sans-serif'),
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
  const worker = webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'pdf.worker.min.mjs'));
  const directory = webview.asWebviewUri(vscode.Uri.joinPath(document.uri, '..')).toString();
  const templateUrls = Object.fromEntries(['simple', 'academic', 'technical', 'cover'].map(name =>
    [name, webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'assets', 'templates', `${name}.svg`)).toString()]));
  const boot = JSON.stringify({ mode, worker: worker.toString(), directory, templateUrls }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' blob:; worker-src blob: ${webview.cspSource}; connect-src ${webview.cspSource} data: blob: https:;">
<link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${appCss}"><title>Markdown Compiler</title></head><body>
<div id="app"></div><script nonce="${nonce}">window.__MDC_BOOT__=${boot};</script><script src="${script}"></script>
</body></html>`;
}

async function openPanel(document: vscode.TextDocument, mode: Mode, column: vscode.ViewColumn, autoExport = false) {
  lastDocument = document.uri;
  const existing = [...panels].find(p => p.uri.toString() === document.uri.toString() && p.mode === mode);
  if (existing) { existing.panel.reveal(column); if (autoExport) post(existing, { type: 'exportNow' }); return existing; }
  const panel = vscode.window.createWebviewPanel('markdownCompiler', `${path.basename(document.uri.fsPath)} · ${mode === 'visual' ? '所见即所得' : mode === 'pdf' ? 'PDF' : '预览'}`, column, {
    enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [extensionContext.extensionUri, vscode.Uri.joinPath(document.uri, '..'), extensionContext.globalStorageUri]
  });
  const state: Panel = { panel, uri: document.uri, mode, autoExport };
  panels.add(state);
  panel.webview.html = webviewHtml(panel.webview, document, mode);
  panel.onDidDispose(() => {
    panels.delete(state);
    if (![...panels].some(other => other.uri.toString() === state.uri.toString())) {
      boundariesByUri.delete(state.uri.toString());
      refreshBoundaryDecorations();
    }
  });
  panel.webview.onDidReceiveMessage(message => handleMessage(state, message));
  return state;
}

function post(state: Panel, message: unknown) { void state.panel.webview.postMessage(message); }
function templatesFor(state: Panel) {
  return extensionContext.globalState.get<any[]>('templates', []).map(template => ({
    id: template.id, name: template.name,
    url: state.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.globalStorageUri, template.file)).toString()
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
  const document = await vscode.workspace.openTextDocument(state.uri);
  try {
    if (message.type === 'ready') {
      post(state, { type: 'document', source: document.getText(), version: document.version, settings: settings(),
        exportSettings: extensionContext.globalState.get('exportSettings', {}), templates: templatesFor(state),
        autoExport: state.autoExport });
      state.autoExport = false;
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
      for (const other of [...panels]) if (other.uri.toString() === document.uri.toString() && other.mode !== 'visual') other.panel.dispose();
      await openPanel(document, 'visual', vscode.ViewColumn.One);
      await extensionContext.globalState.update('lastMode', 'visual');
    } else if (message.type === 'pdf') {
      await showPdf(document);
    } else if (message.type === 'saveSettings') {
      await extensionContext.globalState.update('exportSettings', message.value);
      for (const other of panels) if (other !== state) post(other, { type: 'exportSettings', value: message.value });
    } else if (message.type === 'savePdf') {
      const name = path.basename(document.uri.fsPath).replace(/\.(md|markdown|mdown)$/i, '') + '.pdf';
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(document.uri, '..', name), filters: { PDF: ['pdf'] } });
      if (!target) { post(state, { type: 'exportResult', success: false, cancelled: true }); return; }
      const bytes = Uint8Array.from(Buffer.from(message.data, 'base64'));
      await vscode.workspace.fs.writeFile(target, bytes);
      post(state, { type: 'exportResult', success: true, path: target.fsPath });
      const action = await vscode.window.showInformationMessage(`PDF 已导出：${target.fsPath}`, '打开 PDF');
      if (action === '打开 PDF') await vscode.env.openExternal(target);
    } else if (message.type === 'importTemplate') {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'svg'] } });
      if (!files?.[0]) return;
      const bytes = await vscode.workspace.fs.readFile(files[0]);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('模板图片不能超过 20 MB');
      await vscode.workspace.fs.createDirectory(extensionContext.globalStorageUri);
      const ext = path.extname(files[0].fsPath).toLowerCase();
      const id = crypto.randomUUID();
      const fileName = `template-${id}${ext}`;
      const stored = vscode.Uri.joinPath(extensionContext.globalStorageUri, fileName);
      await vscode.workspace.fs.writeFile(stored, bytes);
      const templates = extensionContext.globalState.get<any[]>('templates', []);
      templates.push({ id, name: path.basename(files[0].fsPath), file: fileName });
      await extensionContext.globalState.update('templates', templates);
      for (const other of panels) post(other, { type: 'templates', templates: templatesFor(other) });
    } else if (message.type === 'exportTemplate') {
      const template = extensionContext.globalState.get<any[]>('templates', []).find(t => t.id === message.id);
      if (!template) return;
      if (!template.file) throw new Error('模板文件不存在');
      const source = vscode.Uri.joinPath(extensionContext.globalStorageUri, template.file);
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), template.name)) });
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
    } else if (message.type === 'scrollTo') {
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === state.uri.toString());
      if (editor) editor.revealRange(new vscode.Range(message.line, 0, message.line, 0), vscode.TextEditorRevealType.AtTop);
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
  for (const state of [...panels]) if (state.uri.toString() === document.uri.toString() && state.mode !== 'preview') state.panel.dispose();
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  await openPanel(document, 'preview', vscode.ViewColumn.Two);
  await extensionContext.globalState.update('lastMode', 'split');
}

async function showPdf(document: vscode.TextDocument) {
  const visual = [...panels].find(p => p.uri.toString() === document.uri.toString() && p.mode === 'visual' && p.panel.active);
  if (visual) {
    post(visual, { type: 'showPdf' });
    visual.panel.reveal();
  } else {
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    await openPanel(document, 'pdf', vscode.ViewColumn.Two);
  }
  await extensionContext.globalState.update('lastMode', 'pdf');
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  boundaryDecoration = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(
    boundaryDecoration,
    vscode.commands.registerCommand('markdownCompiler.openPreferred', async () => {
      const document = await currentDocument();
      if (!document) return;
      const preferred = context.globalState.get<string>('lastMode', 'split');
      if (preferred === 'visual') {
        for (const state of [...panels]) if (state.uri.toString() === document.uri.toString() && state.mode !== 'visual') state.panel.dispose();
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
        for (const state of [...panels]) if (state.uri.toString() === document.uri.toString() && state.mode !== 'visual') state.panel.dispose();
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
      for (const state of panels) if (state.uri.toString() === event.document.uri.toString())
        post(state, { type: 'documentChanged', source: event.document.getText(), version: event.document.version });
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => {
      if (!settings().syncScroll) return;
      for (const state of panels) if (state.mode === 'preview' && state.uri.toString() === event.textEditor.document.uri.toString())
        post(state, { type: 'scrollToLine', line: event.visibleRanges[0]?.start.line ?? 0 });
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('markdownCompiler')) for (const state of panels) post(state, { type: 'settings', value: settings() });
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshBoundaryDecorations()),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.languageId === 'markdown') lastDocument = editor.document.uri;
    })
  );
}

export function deactivate() {}
