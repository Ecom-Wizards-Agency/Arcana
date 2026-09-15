/** Paint the real render-test state markup with repository theme styles. */
import { chromium } from '@playwright/test';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const input = process.env['WP272_VISUAL_DIR'];
const output = process.env['WP272_SCREENSHOT_DIR'];
if (!input || !output) throw new Error('Set WP272_VISUAL_DIR and WP272_SCREENSHOT_DIR');
const files = (await readdir(input)).filter((file) => file.endsWith('.html')).sort();
if (!files.length) throw new Error('No rendered state artifacts');
await mkdir(output, { recursive: true });
const tokens = await readFile(resolve('../../packages/ui/src/tokens.css'), 'utf8');
const styles = (await readFile(resolve('src/ui/theme.css'), 'utf8')).replace(/^@import.*$/m, '');
const experimentStyles = await readFile(resolve('src/screens/timeline/timeline.css'), 'utf8');
const layoutCss = await readFile(resolve('.next/dev/static/css/app/layout.css'), 'utf8');
const latinFace = layoutCss.slice(layoutCss.lastIndexOf('/* latin */'));
const fontFile = /url\(\/_next\/static\/media\/([^)]*\.woff2)\)/.exec(latinFace)?.[1];
if (!fontFile) throw new Error('The local Next build has no Inter Latin font');
const font = (await readFile(resolve('.next/dev/static/media',fontFile))).toString('base64');
const fontStyle = `@font-face { font-family: Inter; font-style: normal; font-weight: 100 900; src: url(data:font/woff2;base64,${font}) format('woff2'); } :root { --font-inter: Inter; }`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
const captures: { source: string; screenshot: string; theme: string; overflow: number }[] = [];
try {
  for (const file of files) {
    const theme = file.includes('-dark-') ? 'dark' : 'light';
    const markup = await readFile(join(input,file),'utf8');
    const routeStyles = file.startsWith('experiments-') ? experimentStyles : '';
    await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${fontStyle}\n${tokens}\n${styles}\n${routeStyles}</style></head><body style="margin:0"><div style="width:1200px;min-height:968px;padding:24px;margin:0 auto">${markup}</div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const screenshot = join(output,file.replace('.html','.png'));
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    const overflow = await page.evaluate(() => Math.max(0,document.documentElement.scrollWidth-window.innerWidth,
      ...Array.from(document.querySelectorAll<HTMLElement>('.wa-support-screen')).map((screen) => screen.scrollWidth-screen.clientWidth)));
    captures.push({ source: file, screenshot, theme, overflow });
  }
} finally { await browser.close(); }
if (captures.length !== files.length) throw new Error('Screenshot count mismatch');
await writeFile(join(output,'manifest.json'),JSON.stringify(captures,null,2));
console.log(JSON.stringify({ states: files.length, screenshots: captures.length, light: captures.filter((item) => item.theme==='light').length, dark: captures.filter((item) => item.theme==='dark').length, overflow: captures.filter((item) => item.overflow>0).length }));
if (captures.some((item) => item.overflow > 0)) throw new Error('A screen overflows its content column');
