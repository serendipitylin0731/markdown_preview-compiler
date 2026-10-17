import { build, context } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
const extension = {
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js',
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['vscode'], sourcemap: true
};
const webview = {
  entryPoints: ['src/webview/app.ts'], outfile: 'dist/webview.js',
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome100',
  sourcemap: true, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }
};
if (process.argv.includes('--watch')) {
  const a = await context(extension); const b = await context(webview);
  await Promise.all([a.watch(), b.watch()]);
  console.log('Watching extension and webview');
} else {
  await Promise.all([build(extension), build(webview)]);
}
copyFileSync('node_modules/katex/dist/katex.min.css', 'dist/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'dist/fonts', { recursive: true });
copyFileSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
