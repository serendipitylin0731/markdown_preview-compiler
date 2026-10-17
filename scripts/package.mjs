import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const output = `packages/markdown-preview-compiler-${version}.vsix`;
mkdirSync('packages', { recursive: true });

const cli = fileURLToPath(new URL('../node_modules/@vscode/vsce/vsce', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'package', '--no-dependencies', '--out', output], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
