const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));

test('Markdown editor title has one icon that opens split preview without reserved shortcuts', () => {
  assert.deepEqual(manifest.contributes.menus['editor/title'].map(item => item.command), ['markdownCompiler.split']);
  assert.equal(manifest.contributes.menus['editor/title'][0].when, 'resourceLangId == markdown');
  const command = manifest.contributes.commands.find(item => item.command === 'markdownCompiler.split');
  assert.ok(command?.icon);
  for (const variant of ['light', 'dark']) {
    assert.ok(fs.existsSync(path.join(root, command.icon[variant])));
  }
  assert.equal(manifest.contributes.keybindings, undefined);
});
