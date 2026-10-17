import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

// Render every supported paper size before packaging. PDF pages use one PNG
// background, so the webview never has to composite the logo and footer art.
const sizes = { a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4] };
const colors = ['red', 'blue'];
const output = new URL('../assets/templates/', import.meta.url);
const dataUrl = (name, type) => `data:${type};base64,${readFileSync(new URL(`../assets/templates/${name}`, import.meta.url)).toString('base64')}`;
const wordmarks = {
  red: dataUrl('sjtu-wordmark.png', 'image/png'),
  blue: dataUrl('sjtu-wordmark-blue.svg', 'image/svg+xml')
};
const frames = Object.fromEntries(colors.flatMap(color => [false, true].map(cover =>
  [`${color}-${cover}`, dataUrl(`sjtu-${color}${cover ? '-cover' : ''}.svg`, 'image/svg+xml')])));
const outlines = Object.fromEntries(colors.map(color =>
  [color, dataUrl(`sjtu-${color}-outline.svg`, 'image/svg+xml')]));

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const color of colors) for (const [paper, portrait] of Object.entries(sizes)) {
    for (const orientation of ['portrait', 'landscape']) for (const cover of [false, true]) {
      const [paperWidth, paperHeight] = orientation === 'portrait' ? portrait : [...portrait].reverse();
      const width = Math.round(paperWidth * 144 / 25.4);
      const height = Math.round(paperHeight * 144 / 25.4);
      const outlineWidth = orientation === 'landscape' ? 25 : 34;
      const lineBottom = cover ? 100 / 14 : 110 / 14;
      const outlineBottom = lineBottom - outlineWidth * paperWidth / paperHeight / 488;
      const lineRight = 7.5 + outlineWidth * 487 / 488;
      const frame = frames[`${color}-${cover}`];
      const html = `<!doctype html><html><head><style>
        *{box-sizing:border-box}html,body{margin:0;background:white}
        #sheet{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#fff}
        #frame{position:absolute;inset:0;width:100%;height:100%}
        #wordmark{position:absolute;left:5%;top:${cover ? 5 : 2.5}%;height:${cover ? 7 : 5}%;width:auto;max-width:85%;object-fit:contain}
        #line{position:absolute;left:${cover ? 7.5 : 4.8}%;right:${lineRight}%;bottom:${lineBottom}%;height:max(1px,0.14%);transform:translateY(50%);background:${color === 'blue' ? '#17618d' : '#c8161e'}}
        #outline{position:absolute;right:7.5%;bottom:${outlineBottom}%;width:${outlineWidth}%;height:auto}
      </style></head><body><div id="sheet"><img id="frame" src="${frame}"><img id="wordmark" src="${wordmarks[color]}"><div id="line"></div><img id="outline" src="${outlines[color]}"></div></body></html>`;
      await page.setViewportSize({ width, height });
      await page.setContent(html);
      await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
      const filename = `sjtu-${color}-${paper}-${orientation}${cover ? '-cover' : ''}.png`;
      await page.locator('#sheet').screenshot({ path: new URL(filename, output).pathname, animations: 'disabled' });
      console.log(filename);
    }
  }
  await page.close();
} finally {
  await browser.close();
}
