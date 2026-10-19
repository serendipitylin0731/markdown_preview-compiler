const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

test('PDF layout starts at defaults for each opening while surviving mode switches in one panel', async () => {
  const uri = file => ({ fsPath: file, toString: () => `file://${file}` });
  const first = { uri: uri('/workspace/one.md'), languageId: 'markdown', version: 1, getText: () => '# One' };
  const second = { uri: uri('/workspace/two.md'), languageId: 'markdown', version: 1, getText: () => '# Two' };
  const documents = [first, second];
  const commands = new Map();
  const panels = [];
  const stored = new Map([
    ['exportSettings', { paper: 'letter', fontSize: 30 }],
    ['templateSelections', { [first.uri.toString()]: { templateRanges: [{ start: 0, end: 2, id: 'academic' }] } }]
  ]);
  const writes = [];
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.resolve(base.fsPath, ...parts)) },
    ViewColumn: { One: 1, Two: 2, Beside: 2 },
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
          title, viewColumn: column, active: true,
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
      onDidChangeTextEditorVisibleRanges: disposable,
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
    await one.deliver({ type: 'ready' });
    assert.deepEqual(one.messages.at(-1).exportSettings, {}, 'old global layout must be ignored');

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

    one.dispose(); two.active = false;
    vscode.window.activeTextEditor = { document: first };
    await commands.get('markdownCompiler.pdf')();
    const reopened = panels.at(-1);
    await reopened.deliver({ type: 'ready' });
    assert.deepEqual(reopened.messages.at(-1).exportSettings, {}, 'reopening a file must reset its layout');
    assert.equal(writes.includes('exportSettings') || writes.includes('templateSelections'), false);
  } finally {
    Module._load = originalLoad;
  }
});
