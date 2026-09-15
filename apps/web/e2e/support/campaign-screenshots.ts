import { expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export async function captureCampaignStates(page: Page, testInfo: TestInfo) {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.mouse.move(0, 0);
  const rendered = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'e2e/support/render-campaigns.ts'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as { count: number; states: { name: string; text: string; html: string }[] };
  expect(rendered.states).toHaveLength(rendered.count);
  const directory = resolve('../../_local/wp270/screenshots');
  await mkdir(directory, { recursive: true });
  const shell = await page.content();
  await page.setContent(shell.replace(/<script[\s\S]*?<\/script>/g, ''));
  await page.locator('main.campaign-page').evaluate((element) => { element.outerHTML = '<div data-campaign-visual></div>'; });
  const paths: string[] = [];
  for (const state of rendered.states) {
    const host = page.locator('[data-campaign-visual]');
    await host.evaluate((element, html) => { element.innerHTML = html; }, state.html);
    await expect(host).toContainText(state.text);
    await page.evaluate(async () => { await document.fonts.ready; });
    const path = join(directory, `${state.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display:none; }' });
    await testInfo.attach(state.name, { path, contentType: 'image/png' }); paths.push(path);
  }
  expect(paths).toHaveLength(rendered.count);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ expected: rendered.count, captured: paths.length, paths }, null, 2));
}
