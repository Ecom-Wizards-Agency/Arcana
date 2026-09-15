import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('captures every saved optimizer state in the operator shell', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await readState();
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/optimizer?profile=${fixture.fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Optimize Now', exact: true })).toBeVisible();
  const shell = (await page.content()).replace(/<script[\s\S]*?<\/script>/g, '');
  const rendered = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'e2e/support/render-optimizer.ts'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as { states: string[]; markup: Record<string, string>; css: string };
  expect(rendered.states).toHaveLength(52);
  expect(rendered.states).toEqual(expect.arrayContaining(['choose-campaigns', 'run-settings', 'missing-group-setting']));
  expect(Object.keys(rendered.markup)).toEqual(rendered.states);
  const directory = resolve(process.env['WP_SCRATCH'] ?? testInfo.project.outputDir, 'tmp', 'screenshots', 'optimizer');
  await mkdir(directory, { recursive: true });
  const screenshots: Array<{ state: string; path: string }> = [];
  for (const state of rendered.states) {
    await page.setContent(shell);
    await page.addStyleTag({ content: rendered.css });
    await page.locator('main').last().evaluate((element, html) => { element.outerHTML = html; }, rendered.markup[state]!);
    await page.evaluate(async () => { await document.fonts.ready; });
    if (state === 'choose-campaigns') {
      await expect(page.getByRole('heading', { name: 'Optimize Now', exact: true })).toBeVisible();
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Get suggestions', exact: true })).toBeDisabled();
    }
    if (state === 'run-settings') {
      await expect(page.getByRole('heading', { name: 'Run settings', exact: true })).toBeVisible();
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Save settings and continue', exact: true })).toBeEnabled();
    }
    if (state === 'missing-group-setting') {
      await expect(page.getByRole('heading', { name: 'Finish campaign setup', exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('If the campaign belongs to a group, update the missing setting in that group.');
      await expect(page.getByRole('button', { name: 'Save settings and continue', exact: true })).toBeDisabled();
      await expect(page.getByLabel('Target ACOS (%)', { exact: true })).toHaveValue('37');
    }
    if (state === 'review-none') await expect(page.getByRole('button', { name: 'Select changes to continue' })).toBeDisabled();
    if (state === 'review-first' || state === 'review-second') await expect(page.getByRole('button', { name: 'Review 1 selected change' })).toBeEnabled();
    if (state === 'review-both') await expect(page.getByRole('button', { name: 'Review 2 selected changes' })).toBeEnabled();
    if (state === 'shadow' || state === 'shadow-full') {
      await expect(page.getByRole('button', { name: 'Send to Amazon unavailable in shadow' })).toBeDisabled();
      await expect(page.getByRole('button', { name: /Yes, apply/ })).toHaveCount(0);
    }
    if (state === 'single-result') await expect(page.getByText('Not yet answerable', { exact: true })).toHaveCount(3);
    if (state === 'exposure-info') await expect(page.getByRole('tooltip')).toBeVisible();
    if (state === 'retry-preview') {
      await expect(page.getByRole('table', { name: 'Refreshed retry changes' }).getByRole('row')).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Review 1 selected change', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: /Yes, apply/ })).toHaveCount(0);
    }
    if (state === 'confirm-both') await expect(page.getByRole('button', { name: 'Yes, apply 2 changes to Amazon', exact: true })).toBeVisible();
    if (state.startsWith('restore-')) {
      await expect(page.getByTestId('restore-source')).toHaveCount(1);
      await expect(page.getByTestId('restore-source')).toContainText('Restore of batch');
      if (['restore-environment-disabled', 'restore-profile-disabled'].includes(state)) await expect(page.getByRole('button', { name: 'Yes, apply 1 changes to Amazon', exact: true })).toBeDisabled();
      if (['restore-confirm', 'restore-retry-confirm'].includes(state)) {
        await expect(page.getByRole('table', { name: 'Immutable restore preview' }).locator('tbody tr')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Yes, apply 1 changes to Amazon', exact: true })).toBeEnabled();
      }
      if (state === 'restore-export') {
        await expect(page.getByRole('heading', { name: 'Amazon writes are not enabled for this profile' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Export restore proposal (1 changes)', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: /Yes, apply/ })).toHaveCount(0);
      }
      if (state === 'restore-partial') await expect(page.getByTestId('optimizer-result-counts')).toHaveText('Requested 2 · Attempted 2 · Accepted 1 · Failed 1 · Confirmed in sync 1');
      if (state === 'restore-single') await expect(page.getByTestId('optimizer-result-counts')).toHaveText('Requested 1 · Attempted 1 · Accepted 1 · Failed 0 · Confirmed in sync 0');
      if (state === 'restore-conflict') await expect(page.getByText('Observed state conflicts with the request')).toBeVisible();
      if (state === 'restore-retry-preview') await expect(page.getByRole('table', { name: 'Refreshed retry changes' }).locator('tbody tr')).toHaveCount(1);
    }
    const path = join(directory, `${state}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
    expect((await readFile(path)).byteLength, `${state}: screenshot has content`).toBeGreaterThan(1000);
    screenshots.push({ state, path });
    await testInfo.attach(`Optimize Now ${state}`, { path, contentType: 'image/png' });
  }
  expect(screenshots.map((artifact) => artifact.state)).toEqual(rendered.states);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(screenshots, null, 2));
});
