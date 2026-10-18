const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'src/image-source.ts');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code, filename);
const { imageDataUrl } = compiled.exports;
const logo = fs.readFileSync(path.join(root, 'assets/logo.png'));

test('local relative and remote images resolve to browser-readable image data without CORS headers', async () => {
  let requestedPath;
  const local = await imageDataUrl('../assets/logo.png', async source => { requestedPath = source; return logo; });
  assert.equal(requestedPath, '../assets/logo.png');
  assert.equal(local, `data:image/png;base64,${logo.toString('base64')}`);

  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'image/png');
    response.end(logo);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const remote = await imageDataUrl(`http://127.0.0.1:${server.address().port}/figure.png`, async () => {
      throw new Error('remote URL was treated as a file');
    });
    assert.equal(remote, local);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('image resolver rejects non-image responses', async () => {
  await assert.rejects(imageDataUrl('./bad.png', async () => Buffer.from('<html>not an image</html>')), /图片格式不受支持/);
});
