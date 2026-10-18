const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

test('SJTU backgrounds use the approved figure image', () => {
  const image = fs.readFileSync(path.join(root, 'assets/templates/sjtu-outline-reference.png'));
  assert.equal(crypto.createHash('sha256').update(image).digest('hex'),
    '67bd2450af839db7bd90906b2bef40d9762805c5b23e1fb54424c2721d81a1cd');
  assert.equal(image.readUInt32BE(16), 2170);
  assert.equal(image.readUInt32BE(20), 725);
  const renderer = fs.readFileSync(path.join(root, 'scripts/render-sjtu-templates.mjs'), 'utf8');
  assert.match(renderer, /sjtu-outline-approved/);
  assert.doesNotMatch(renderer, /sjtu-\$\{color\}-outline\.svg/);
  assert.equal(manifest.icon, 'assets/logo.png');
  assert.ok(fs.existsSync(path.join(root, manifest.icon)));
});
