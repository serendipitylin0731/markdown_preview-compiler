const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

test('PDF layout persists by file across previews without mixing files', async () => {
  const uri = file => ({ fsPath: file, toString: () => `file://${file}` });
  const first = { uri: uri('/workspace/one.md'), languageId: 'markdown', version: 1, lineCount: 100, getText: () => '# One' };
  const second = { uri: uri('/workspace/two.md'), languageId: 'markdown', version: 1, lineCount: 100, getText: () => '# Two' };
  const documents = [first, second];
  const commands = new Map();
  const panels = [];
  let visibleRangeListener, selectionListener;
  const stored = new Map([
    ['exportSettings', { paper: 'letter', fontSize: 30 }],
    ['templateSelections', { [first.uri.toString()]: { templateRanges: [{ start: 0, end: 2, id: 'academic' }] } }]
  ]);
  const writes = [];
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.resolve(base.fsPath, ...parts)) },
    ViewColumn: { One: 1, Two: 2, Beside: 2 },
    Range: class { constructor(line) { this.start = { line }; } },
    TextEditorRevealType: { AtTop: 1 },
    workspace: {
      textDocuments: documents,
      openTextDocument: async requested => documents.find(doc => doc.uri.toString() === requested.toString()),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeTextDocument: disposable,
      onDidChangeConfiguration: disposable
    },
    window: {
      activeTextEditor: { document: first }, visibleTextEditors: [],
      createTextEditorDecorationType: disposable,
      showTextDocument: async document => { vscode.window.activeTextEditor = { document }; },
      createWebviewPanel: (_kind, title, column) => {
        const messages = [];
        let receive, dispose;
        const panel = {
          title, viewColumn: column, active: true, visible: true,
          webview: {
            asWebviewUri: value => value,
            postMessage: message => { messages.push(message); return Promise.resolve(true); },
            onDidReceiveMessage: callback => { receive = callback; return disposable(); }
          },
          onDidDispose: callback => { dispose = callback; return disposable(); },
          reveal() { this.active = true; },
          dispose() { this.active = false; dispose?.(); },
          deliver: message => receive(message), messages
        };
        panels.push(panel);
        return panel;
      },
      onDidChangeTextEditorVisibleRanges: callback => { visibleRangeListener = callback; return disposable(); },
      onDidChangeTextEditorSelection: callback => { selectionListener = callback; return disposable(); },
      onDidChangeVisibleTextEditors: disposable,
      onDidChangeActiveTextEditor: disposable
    },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } }
  };
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
  };
  try {
    const extension = require('../dist/extension.js');
    extension.activate({
      extensionUri: uri('/extension'), globalStorageUri: uri('/storage'), subscriptions: [],
      globalState: {
        get: (key, fallback) => stored.has(key) ? stored.get(key) : fallback,
        update: async (key, value) => { writes.push(key); stored.set(key, value); }
      }
    });
    await commands.get('markdownCompiler.pdf')();
    const one = panels.at(-1);
    vscode.window.visibleTextEditors = [{ document: first, selection: { active: { line: 4, character: 2 } }, setDecorations() {} }];
    await one.deliver({ type: 'ready' });
    assert.deepEqual(one.messages.at(-1).exportSettings, {}, 'old global layout must be ignored');
    assert.deepEqual(one.messages.at(-1).cursor, { line: 4, character: 2 });
    await one.deliver({ type: 'saveAppearance', value: { fontFamily: 'serif', theme: 'dark' } });
    await one.deliver({ type: 'saveSettings', value: { paper: 'a5', marginTop: 37, template: 'academic',
      templateRanges: [{ start: 0, end: 1, id: 'technical' }] } });
    await one.deliver({ type: 'visual' });
    await one.deliver({ type: 'ready' });
    assert.deepEqual(one.messages.at(-1).exportSettings, { paper: 'a5', marginTop: 37, template: 'academic',
      templateRanges: [{ start: 0, end: 1, id: 'technical' }] }, 'mode switch should keep this open panel layout');

    one.active = false;
    vscode.window.activeTextEditor = { document: second };
    await commands.get('markdownCompiler.pdf')();
    const two = panels.at(-1);
    await two.deliver({ type: 'ready' });
    assert.deepEqual(two.messages.at(-1).exportSettings, {}, 'another file must open with defaults');
    assert.deepEqual(two.messages.at(-1).appearance, { fontFamily: 'serif', theme: 'dark' },
      'preview appearance must survive opening another file');
    await two.deliver({ type: 'saveAppearance', value: { fontFamily: 'serif', theme: 'light' } });
    assert.deepEqual(one.messages.at(-1), { type: 'appearance', value: { fontFamily: 'serif', theme: 'light' } },
      'appearance changes must update other open previews');
    await two.deliver({ type: 'saveSettings', value: { paper: 'letter', marginTop: 18 } });

    one.dispose(); two.active = false;
    vscode.window.activeTextEditor = { document: first };
    await commands.get('markdownCompiler.pdf')();
    const reopened = panels.at(-1);
    await reopened.deliver({ type: 'ready' });
    assert.deepEqual(reopened.messages.at(-1).exportSettings, { paper: 'a5', marginTop: 37, template: 'academic',
      templateRanges: [{ start: 0, end: 1, id: 'technical' }] }, 'reopening a file must restore its own layout');
    two.dispose(); reopened.active = false;
    vscode.window.activeTextEditor = { document: second };
    await commands.get('markdownCompiler.pdf')();
    const reopenedSecond = panels.at(-1);
    await reopenedSecond.deliver({ type: 'ready' });
    assert.deepEqual(reopenedSecond.messages.at(-1).exportSettings, { paper: 'letter', marginTop: 18 });
    assert.ok(writes.includes(`pdfLayout:${first.uri.toString()}`));
    assert.ok(writes.includes(`pdfLayout:${second.uri.toString()}`));
    assert.equal(writes.includes('exportSettings') || writes.includes('templateSelections'), false);

    reopenedSecond.active = false;
    vscode.window.activeTextEditor = { document: second };
    await commands.get('markdownCompiler.split')();
    const reveals = [];
    const editor = { document: second, selection: { active: { line: 0, character: 0 } },
      visibleRanges: [{ start: { line: 3, character: 0 } }], setDecorations() {},
      revealRange(range) { reveals.push(range.start.line); } };
    vscode.window.visibleTextEditors = [editor];
    await reopenedSecond.deliver({ type: 'ready' });
    assert.deepEqual(reopenedSecond.messages.at(-1).visiblePosition, { line: 3, character: 0 });
    visibleRangeListener({ textEditor: editor, visibleRanges: [{ start: { line: 4, character: 5 }, end: { line: 12, character: 0 } }] });
    assert.deepEqual(reopenedSecond.messages.at(-1), { type: 'scrollToLine', line: 4, character: 5, endLine: 12 });
    const sent = reopenedSecond.messages.length;
    editor.visibleRanges = [{ start: { line: 4, character: 5 }, end: { line: 12, character: 0 } }];
    selectionListener({ textEditor: editor, selections: [{ active: { line: 6, character: 0 } }] });
    assert.equal(reopenedSecond.messages.length, sent + 1);
    assert.deepEqual(reopenedSecond.messages.at(-1), { type: 'cursorPosition', line: 6, character: 0,
      visibleStartLine: 4, visibleEndLine: 12 });
    editor.visibleRanges = [{ start: { line: 8, character: 0 } }];
    selectionListener({ textEditor: editor, selections: [{ active: { line: 8, character: 0 } }] });
    assert.deepEqual(reopenedSecond.messages.at(-1), { type: 'cursorPosition', line: 8, character: 0,
      visibleStartLine: 8 },
      'moving the caret should not first scroll to the editor viewport');
    editor.visibleRanges = [{ start: { line: 10, character: 0 } }];
    await new Promise(resolve => setTimeout(resolve, 330));
    assert.deepEqual(reopenedSecond.messages.at(-1), { type: 'scrollToLine', line: 10, character: 0 },
      'polling should catch editor scrolling when VS Code skips a visible-range event');
    const beforePreviewScroll = reopenedSecond.messages.length;
    await reopenedSecond.deliver({ type: 'scrollTo', line: 0 });
    assert.deepEqual(reveals, [0], 'user preview scrolling should move the editor');
    editor.visibleRanges = [{ start: { line: 5, character: 0 } }];
    visibleRangeListener({ textEditor: editor, visibleRanges: editor.visibleRanges });
    assert.equal(reopenedSecond.messages.length, beforePreviewScroll,
      'editor reveal must not echo back when source and preview line numbers differ');
    await new Promise(resolve => setTimeout(resolve, 330));
    editor.visibleRanges = [{ start: { line: 20, character: 0 } }];
    visibleRangeListener({ textEditor: editor, visibleRanges: editor.visibleRanges });
    assert.deepEqual(reopenedSecond.messages.at(-1), { type: 'scrollToLine', line: 20, character: 0 });
  } finally {
    Module._load = originalLoad;
  }
});
