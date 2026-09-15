import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function waitForCreativeShell(page: Page): Promise<void> {
  await expect(page.locator('.wa-shell-chips')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('Loading freshness…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Loading crosscheck…', { exact: true })).toHaveCount(0);
}

/** Screenshot actual React presentations inside the authenticated application's shell. */
export async function captureCreativeStates(
  page: Page,
  testInfo: TestInfo,
  screen: 'creative' | 'sponsored-prompts',
  markupByState: Readonly<Record<string, string>>,
  mainSelector: string,
): Promise<string[]> {
  const states = Object.keys(markupByState);
  expect(states.length).toBeGreaterThan(0);
  await expect(page.locator(mainSelector)).toHaveCount(1);
  await waitForCreativeShell(page);
  const shell = (await page.content()).replace(/<script[\s\S]*?<\/script>/g, '');
  const directory = resolve(testInfo.project.outputDir, '..', 'wp267', screen);
  await mkdir(directory, { recursive: true });
  const screenshots: string[] = [];
  for (const [state, markup] of Object.entries(markupByState)) {
    expect(markup, `${screen}/${state} must render content`).not.toBe('');
    await page.setContent(shell);
    await page.locator(mainSelector).evaluate((element, html) => { element.outerHTML = html; }, markup);
    await page.evaluate(async () => { await document.fonts.ready; });
    await waitForCreativeShell(page);
    await expect(page.locator('body')).toContainText(/.+/);
    const horizontal = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(horizontal.document, `${screen}/${state}: wide tables remain inside the content column`).toBeLessThanOrEqual(horizontal.viewport + 1);
    const overflowingMetrics = await page.locator('main dd').evaluateAll((cells) => cells
      .filter((cell) => cell.checkVisibility() && cell.scrollWidth > cell.clientWidth + 1)
      .map((cell) => ({ text: cell.textContent, clientWidth: cell.clientWidth, scrollWidth: cell.scrollWidth })));
    expect(overflowingMetrics, `${screen}/${state}: KPI values fit their cells`).toEqual([]);
    const thumbnailsFit = await page.locator('main span[role="img"]').evaluateAll((tiles) => tiles.every((tile) => tile.scrollWidth <= tile.clientWidth + 1 && tile.scrollHeight <= tile.clientHeight + 1));
    expect(thumbnailsFit, `${screen}/${state}: thumbnail fallbacks fit their tiles`).toBe(true);
    const path = join(directory, `${state}-1440x1024.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
    await testInfo.attach(`${screen}: ${state}`, { path, contentType: 'image/png' });
    screenshots.push(path);
  }
  expect(screenshots).toHaveLength(states.length);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ screen, states, screenshots }, null, 2));
  return screenshots;
}
