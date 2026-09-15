import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
export async function researchScreenshots(page: Page, testInfo: TestInfo, screen: 'queries' | 'ngrams' | 'dayparting' | 'brand-lens') {
  await page.setViewportSize({width:1440,height:1024});
  const markup = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'e2e/support/render-research.ts', screen], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })) as Record<string, string>;
  const css = await readFile('src/screens/query-intelligence/research.css', 'utf8');
  const dayCss = await readFile('src/screens/dayparting/workspace.css', 'utf8');
  const measurementCss=await readFile('app/dayparting/dayparting.module.css','utf8');
  const shell = (await page.content()).replace(/<script[\s\S]*?<\/script>/g, '');
  const directory = resolve('node_modules', '.cache', 'playwright', 'wp266-round1', screen);
  await mkdir(directory, { recursive: true });
  const screenshots: string[] = [];
  for (const [state, html] of Object.entries(markup)) {
    await page.setContent(shell);
    await page.addStyleTag({ content: css + '\n' + dayCss + '\n' + measurementCss });
    const main = page.locator('main').first();
    await main.evaluate((element, content) => {
      element.innerHTML = content;
    }, html);
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    const path = join(directory, `${state}.png`);
    await page.screenshot({
      path,
      fullPage: true,
      animations: 'disabled',
      style: 'nextjs-portal {display:none;}'
    });
    await testInfo.attach(`${screen} ${state}`, {
      path,
      contentType: 'image/png'
    });
    screenshots.push(path);
  }
  expect(screenshots).toHaveLength(Object.keys(markup).length);
  return screenshots;
}
export async function researchInteractionScreenshot(page: Page, testInfo: TestInfo, screen: string, state: string) {
  await page.setViewportSize({ width: 1440, height: 1024 });
  const directory = resolve('node_modules', '.cache', 'playwright', 'wp266-round1', screen);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${state}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal {display:none;}' });
  await testInfo.attach(`${screen} ${state}`, { path, contentType: 'image/png' });
}
