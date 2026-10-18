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
  [color, dataUrl(`sjtu-outline-approved${color === 'blue' ? '-blue' : ''}.png`, 'image/png')]));

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const color of colors) for (const [paper, portrait] of Object.entries(sizes)) {
    for (const orientation of ['portrait', 'landscape']) for (const cover of [false, true]) {
      const [paperWidth, paperHeight] = orientation === 'portrait' ? portrait : [...portrait].reverse();
      const width = Math.round(paperWidth * 216 / 25.4);
      const height = Math.round(paperHeight * 216 / 25.4);
      const outlineWidth = orientation === 'landscape' ? 25 : 34;
      const lineBottom = cover ? 100 / 14 : 110 / 14;
      const frame = frames[`${color}-${cover}`];
      const html = `<!doctype html><html><head><style>
        *{box-sizing:border-box}html,body{margin:0;background:white}
        #sheet{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#fff}
        #frame{position:absolute;inset:0;width:100%;height:100%}
        #wordmark{position:absolute;left:5%;top:${cover ? 3.5 : 0.8}%;height:${cover ? 9 : 6.6}%;width:auto;max-width:85%;object-fit:contain}
        #footer{position:absolute;inset:0;width:100%;height:100%}
        #outline{display:none}
      </style></head><body><div id="sheet"><img id="frame" src="${frame}"><img id="wordmark" src="${wordmarks[color]}"><canvas id="footer" width="${width}" height="${height}"></canvas><img id="outline" src="${outlines[color]}"></div></body></html>`;
      await page.setViewportSize({ width, height });
      await page.setContent(html);
      await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
      await page.evaluate(({ outlineWidth, lineBottom, cover }) => {
        const source = document.querySelector('#outline');
        const canvas = document.querySelector('#footer');
        const context = canvas.getContext('2d');
        const width = canvas.width, height = canvas.height;
        const motifWidth = width * outlineWidth / 100;
        const scale = motifWidth / source.naturalWidth;
        const motifHeight = source.naturalHeight * scale;
        const motifX = width * .925 - motifWidth;
        const motifY = height * (1 - lineBottom / 100) - 279 * scale;
        const lineLeft = width * (cover ? .075 : .048);
        // Copy an untouched one-pixel column from the original horizontal line.
        // Scaling it with the motif gives the extension the same thickness and color.
        const stripeX = 90;
        context.drawImage(source, stripeX, 0, 1, source.naturalHeight,
          lineLeft, motifY, motifX + stripeX * scale - lineLeft, motifHeight);
        context.drawImage(source, motifX, motifY, motifWidth, motifHeight);
      }, { outlineWidth, lineBottom, cover });
      const filename = `sjtu-${color}-${paper}-${orientation}${cover ? '-cover' : ''}.png`;
      await page.locator('#sheet').screenshot({ path: new URL(filename, output).pathname, animations: 'disabled' });
      console.log(filename);
    }
  }
  await page.close();
} finally {
  await browser.close();
}
