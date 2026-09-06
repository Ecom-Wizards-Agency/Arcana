/**
 * The five browser flows WP-07 and WP-209 are accepted on:
 *
 *   1. the queue is one Data Grid, full width, sorting and grouping like every
 *      other operator table, and the provenance panel renders every `inputs`
 *      field plus the change reason, the limit reason and the strategy;
 *   2. the queue's own row is reachable, and filtered selection and the
 *      progressive decision panels stay keyboard-reachable, on a phone-sized
 *      viewport;
 *   3. a decision updates in place: the active filter, the selection and the
 *      open evidence survive it and the result is reported inline;
 *   4. accept → export moves the status and produces the three files, and a
 *      dismissed proposal is not in the export;
 *   5. the n-gram explorer toggles uni/bi/tri and turns a gram into proposals
 *      without writing anything.
 *
 * Everything runs against a real Next server on a real migrated database; see
 * `e2e/run.ts`, which also seeds the run and the search terms.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { RELEASE_ARTIFACT } from '../src/ui/artifact-markers';

const PROFILE = process.env['WIZARD_ADS_E2E_PROFILE_A'] ?? '';
const PROPOSALS = Number(process.env['WIZARD_ADS_E2E_REC_PROPOSALS'] ?? '0');
const SEARCH_TERMS = Number(process.env['WIZARD_ADS_E2E_REC_SEARCH_TERMS'] ?? '0');

const INPUT_KEYS = ['rpc', 'clicks', 'cvrSourceLevel', 'ceilingApplied', 'capClamped', 'window'];

async function openReview(page: Page): Promise<void> {
  await page.goto(`/recommendations?profile=${PROFILE}`);
  const review = page.locator('main[data-interactive="true"]');
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute(
    'data-release-artifact',
    RELEASE_ARTIFACT.recommendationReview,
  );
}

async function openExplorer(page: Page): Promise<void> {
  await page.goto(`/ngrams?profile=${PROFILE}`);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

/** Every proposal on screen. Group rows carry no proposal marker. */
function proposalRows(page: Page): Locator {
  return page.locator('[data-testid^="proposal-"]');
}

/** The grid row holding one proposal, for its checkbox and its cells. */
function rowFor(page: Page, id: string): Locator {
  return page.getByTestId('grid-row').filter({ has: page.getByTestId(`proposal-${id}`) });
}

async function firstProposalId(page: Page): Promise<string> {
  const id = (await proposalRows(page).first().getAttribute('data-testid'))?.replace('proposal-', '') ?? '';
  expect(id).not.toBe('');
  return id;
}

test.describe('recommendations review', () => {
  test('shows every proposal in one full-width grid, with its work and its strategy', async ({ page }) => {
    await openReview(page);

    // Full width, one continuous grid, and none of the nested tables the
    // decision lanes used to be.
    const viewport = page.getByTestId('grid-viewport');
    const viewportBox = await viewport.boundingBox();
    const contentBox = await page.locator('main').boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(viewportBox!.width).toBeGreaterThanOrEqual(contentBox!.width - 2);
    await expect(page.locator('main table')).toHaveCount(0);

    // Every loaded proposal is a row, and the count says what population that is.
    await expect(proposalRows(page)).toHaveCount(PROPOSALS);
    await expect(page.getByTestId('queue-count')).toHaveText(
      `${PROPOSALS} of ${PROPOSALS} loaded rows shown`,
    );
    // Decision-queue order survives the conversion: needs review leads, and the
    // lane the old sections carried is a column on the row.
    await expect(page.getByTestId('grid-row').first()).toContainText('Needs review');

    // The objective column: resolved from the run's own strategy snapshot.
    const id = await firstProposalId(page);
    await expect(page.getByTestId(`objective-${id}`)).toHaveText('Rank · rank-launch');

    await page.getByTestId(`evidence-toggle-${id}`).click();
    const panel = page.getByTestId(`provenance-${id}`);
    await expect(panel).toBeVisible();
    for (const key of INPUT_KEYS) {
      await expect(panel.locator(`[data-provenance="${key}"]`)).toHaveCount(1);
    }
    // Change reason and limit reason are two facts, not one.
    await expect(panel).toContainText('Change reason');
    await expect(page.getByTestId(`limit-${id}`)).toContainText('data_based_ad_group');
    await expect(page.getByTestId(`strategy-${id}`)).toContainText('rank-launch');

    // The evidence shares the viewport column with the grid and never starves
    // it: an open panel scrolls itself rather than shrinking the queue away.
    const scrollerBox = await page.getByTestId('grid-scroller').boundingBox();
    expect(scrollerBox).not.toBeNull();
    expect(scrollerBox!.height).toBeGreaterThan(100);

    // Click-to-sort on a data column; the control columns never claim one.
    const entity = page.getByRole('columnheader', { name: 'Entity', exact: true });
    await entity.click();
    await expect(entity).toHaveAttribute('aria-sort', 'descending');
    await entity.click();
    await expect(entity).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('columnheader', { name: 'Select', exact: true }))
      .not.toHaveAttribute('aria-sort', /.*/);
    await expect(page.getByRole('columnheader', { name: 'Evidence', exact: true }))
      .not.toHaveAttribute('aria-sort', /.*/);

    // Drag a header into the group bar: the lanes come back as a treegrid, and
    // the surface says the rows became summaries.
    const bar = page.getByTestId('grid-group-bar');
    await expect(bar).toContainText('Drag a column header here');
    await page.getByRole('columnheader', { name: 'Queue', exact: true }).dragTo(bar);
    await expect(page.getByRole('list', { name: 'Ordered grouping levels' }).getByRole('listitem'))
      .toHaveCount(1);
    await expect(page.getByRole('treegrid', { name: 'Results grouped by queue' })).toBeVisible();
    await expect(page.getByTestId('queue-grouped-note')).toContainText('Remove the grouping levels');
    await expect(proposalRows(page)).toHaveCount(0);
  });

  test('keeps filtered selection and progressive decisions keyboard-accessible on mobile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReview(page);

    await expect(page.getByTestId('review-filters')).toBeVisible();
    await expect(page.getByTestId('review-actionbar')).toBeVisible();

    // The queue itself has to survive this width, not just the controls above
    // it. `Select` (44 px) and a pinned `Entity` (260 px) would together claim
    // 304 of 390 and leave the other ten columns 86 to share, so `Entity`
    // scrolls with the rest below the breakpoint and only the checkbox stays
    // put. The proof is that the far end of the row is reachable and readable.
    const scroller = page.getByTestId('grid-scroller');
    await expect(scroller).toBeVisible();
    const entity = page.getByRole('columnheader', { name: 'Entity', exact: true });
    await expect(entity).toHaveCSS('position', 'relative');
    await expect(page.getByRole('columnheader', { name: 'Select', exact: true }))
      .toHaveCSS('position', 'sticky');
    const overflow = await scroller.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeGreaterThan(0);

    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const status = page.getByRole('columnheader', { name: 'Status', exact: true });
    const statusBox = await status.boundingBox();
    const pinnedBox = await page
      .getByRole('columnheader', { name: 'Select', exact: true })
      .boundingBox();
    expect(statusBox).not.toBeNull();
    expect(pinnedBox).not.toBeNull();
    // Wholly on screen, and clear of the one column that stays pinned over it.
    expect(statusBox!.x).toBeGreaterThanOrEqual(pinnedBox!.x + pinnedBox!.width);
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(390);

    await page.getByRole('combobox', { name: 'Reason' }).selectOption('high_acos');
    await page.getByRole('button', { name: 'Select all 1 filtered loaded rows' }).click();
    await expect(page.getByTestId('selection-count')).toContainText(
      '1 of 1 filtered loaded rows selected · 0 accepted',
    );

    const dismiss = page.getByRole('button', { name: 'Dismiss 1 selected' });
    await dismiss.click();
    await expect(page.getByLabel('Dismissal note')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Dismissal note')).toHaveCount(0);
    await expect(dismiss).toBeFocused();
  });

  test('a decision keeps the active filter, the selection and the open evidence, and reports itself inline', async ({
    page,
  }) => {
    await openReview(page);

    // Build a working state: one filter, one selected row, its evidence open.
    await page.getByRole('combobox', { name: 'Reason' }).selectOption('high_acos');
    await expect(page.getByTestId('queue-count')).toHaveText(
      `1 of ${PROPOSALS} loaded rows shown`,
    );
    const id = await firstProposalId(page);
    await rowFor(page, id).getByRole('checkbox').check();
    await expect(page.getByTestId('selection-count')).toContainText(
      '1 of 1 filtered loaded rows selected',
    );
    await page.getByTestId(`evidence-toggle-${id}`).click();
    await expect(page.getByTestId(`provenance-${id}`)).toBeVisible();

    await page.getByRole('button', { name: 'Accept 1 selected' }).click();

    // The decision is reported on the screen that made it, rather than being
    // wiped by the reload this used to end in.
    await expect(page.getByTestId('decision-result')).toHaveText(
      '1 of 1 proposals moved to accepted.',
    );
    await expect(page.locator(`[data-testid="proposal-${id}"]`))
      .toHaveAttribute('data-status', 'accepted');

    // And every piece of that working state is still standing.
    await expect(page.getByRole('combobox', { name: 'Reason' })).toHaveValue('high_acos');
    await expect(page.getByTestId('queue-count')).toHaveText(
      `1 of ${PROPOSALS} loaded rows shown`,
    );
    await expect(page.getByTestId('selection-count')).toContainText(
      '1 of 1 filtered loaded rows selected · 1 accepted',
    );
    await expect(page.getByTestId(`provenance-${id}`)).toBeVisible();
    await expect(page.getByTestId('run-counts')).toContainText('1 accepted');

    // Re-open it, so the run is exactly as this test found it, and prove on a
    // fresh load that both writes really reached the database.
    await page.getByRole('button', { name: 'Re-open 1 selected' }).click();
    await expect(page.getByTestId('decision-result')).toHaveText(
      '1 of 1 proposals moved to proposed.',
    );
    await openReview(page);
    await expect(page.getByTestId('run-counts')).toContainText(`${PROPOSALS} new proposals`);
  });

  test('accept, dismiss and export: the three-act gesture, and dismissed rows never export', async ({
    page,
  }) => {
    await openReview(page);

    // Dismiss the low-visibility proposal, with the note the route demands.
    await page.getByRole('combobox', { name: 'Reason' }).selectOption('low_visibility');
    await expect(page.getByTestId('queue-count')).toHaveText(
      `1 of ${PROPOSALS} loaded rows shown`,
    );
    await proposalRows(page).first().waitFor();
    await rowFor(page, await firstProposalId(page)).getByRole('checkbox').check();
    await expect(page.getByTestId('selection-count')).toContainText('1 of');
    await page.getByRole('button', { name: 'Dismiss 1 selected' }).click();
    await page.getByLabel('Dismissal note').fill('Rank target: never cut on ACOS alone.');
    await page.getByRole('button', { name: 'Confirm dismissal · 1' }).click();
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
    await expect(page.getByTestId('run-counts')).toContainText('1 dismissed');

    // Accept everything still proposed.
    await page.getByRole('combobox', { name: 'Reason' }).selectOption('');
    await page.getByRole('combobox', { name: 'Status' }).selectOption('proposed');
    await page
      .getByRole('button', { name: `Select all ${PROPOSALS - 1} filtered loaded rows` })
      .click();
    await expect(page.getByTestId('selection-count')).toContainText(
      `${PROPOSALS - 1} of ${PROPOSALS - 1} filtered loaded rows selected · 0 accepted`,
    );
    await page.getByRole('button', { name: `Accept ${PROPOSALS - 1} selected` }).click();
    await expect(page.getByTestId('decision-result')).toHaveText(
      `${PROPOSALS - 1} of ${PROPOSALS - 1} proposals moved to accepted.`,
    );
    await expect(page.getByTestId('run-counts')).toContainText(`${PROPOSALS - 1} accepted`);

    // Act two of the gesture is separate from act three: pressing Export
    // without the confirmation is refused.
    await page.getByRole('button', { name: `Prepare export · ${PROPOSALS - 1}` }).click();
    await page.getByLabel('Export note').fill('Weekly rank batch.');
    await page.getByLabel('Strategy group for export').selectOption('Rank');
    await page.getByTestId('export-accepted').click();
    await expect(page.getByTestId('review-error')).toContainText('Yes, export changes');

    await page.getByRole('checkbox', { name: 'Yes, export changes' }).check();
    await page.getByTestId('export-accepted').click();
    const result = page.getByTestId('export-result');
    await expect(result).toContainText(`Exported ${PROPOSALS - 1} of ${PROPOSALS - 1} accepted`);
    await expect(result).toContainText('-rank-bid-down');
    // The caps come from the Rank group in the run's own snapshot.

    // The files exist and the rows JSON holds exactly the exported set — the
    // dismissed proposal is not in it.
    const href = (await result.textContent())?.match(/rows (\/api\S+)/)?.[1] ?? '';
    expect(href).not.toBe('');
    const rows = await page.request.get(href);
    expect(rows.ok()).toBe(true);
    const parsed = (await rows.json()) as { entity_id: string; field: string }[];
    expect(parsed).toHaveLength(PROPOSALS - 1);
    expect(parsed.some((row) => row.entity_id === 'tg-1')).toBe(false);

    const workbook = await page.request.get(href.replace('format=rows', 'format=xlsx'));
    expect(workbook.ok()).toBe(true);
    expect(workbook.headers()['content-disposition']).toContain('-bulk.xlsx');
    expect(workbook.headers()['x-wizard-ads-skipped-rows']).toBe('0');

    const caps = await page.request.get(href.replace('format=rows', 'format=caps'));
    expect(caps.ok()).toBe(true);
    const capsBody = (await caps.json()) as { validateCommand: string; targetAcos: number };
    expect(capsBody.validateCommand).toContain('batches.py validate');
    expect(capsBody.targetAcos).toBe(0.4);

    // And the statuses moved.
    await openReview(page);
    await expect(page.getByTestId('run-counts')).toContainText(`${PROPOSALS - 1} exported`);
    await expect(page.locator('[data-testid^="proposal-"][data-status="dismissed"]')).toHaveCount(1);
  });
});

test.describe('n-gram explorer', () => {
  test('toggles gram size and proposes negatives without writing anything', async ({ page }) => {
    await openExplorer(page);
    await expect(page.getByTestId('gram-count')).toContainText(`${SEARCH_TERMS} search terms`);

    // Bigrams by default; unigrams pool the same terms differently, and the
    // count changes without a round trip because the engine runs in the page.
    const bigrams = (await page.getByTestId('gram-count').textContent()) ?? '';
    await page.getByRole('button', { name: 'Unigrams' }).click();
    await expect(page.getByTestId('gram-count')).not.toHaveText(bigrams);

    // The explorer now uses the same composable filter model as the main Grid.
    // Filter one exact gram and prove the result count and export agree.
    const gramRows = page.getByTestId('grid-row');
    const firstGram =
      (await gramRows.first().getByRole('cell').first().textContent())?.trim() ?? '';
    const secondGram =
      (await gramRows.nth(1).getByRole('cell').first().textContent())?.trim() ?? '';
    expect(firstGram).not.toBe('');
    expect(secondGram).not.toBe('');
    expect(secondGram).not.toBe(firstGram);
    await page.getByLabel('Filter column').selectOption('GRAM');
    await page.getByLabel('Filter operator').selectOption('=');
    await page.getByLabel('Filter value').fill(firstGram);
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByTestId('filtered-gram-count')).toHaveText(/1 of \d+ grams/);
    const exportButton = page.getByRole('button', { name: /Export CSV \(1 of \d+\)/ });
    await expect(exportButton).toBeVisible();
    await expect(page.getByTestId('grid-row')).toHaveCount(1);

    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(download.suggestedFilename()).toMatch(/^openspell-n-gram-explorer-/);
    const csv = await readFile(downloadPath!, 'utf8');
    expect(csv.trim().split(/\r?\n/)).toHaveLength(3);

    // Click a gram to see the terms behind it: you negate terms, not grams.
    await page.getByTestId('grid-row').first().click();
    await page.getByRole('button', { name: /Select all \d+/ }).click();

    // A new filter clears the old, now-hidden action scope.
    await page.getByRole('button', { name: 'Remove filter GRAM' }).click();
    await page.getByLabel('Filter value').fill(secondGram);
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByTestId('gram-terms')).toHaveCount(0);
    await expect(
      page.getByText('Select a gram to see the search terms behind it and propose negatives.'),
    ).toBeVisible();

    await page.getByTestId('grid-row').first().click();
    const terms = page.getByTestId('gram-terms');
    await expect(terms).toBeVisible();

    const selectAll = terms.getByRole('button', { name: /Select all \d+/ });
    const chosen = Number(((await selectAll.textContent()) ?? '').match(/\d+/)?.[0] ?? '0');
    expect(chosen).toBeGreaterThan(0);
    expect(chosen).toBeLessThanOrEqual(SEARCH_TERMS);
    await selectAll.click();
    await terms.getByRole('button', { name: 'Propose selected as negatives' }).click();

    const result = page.getByTestId('propose-result');
    await expect(result).toContainText(`Proposed ${chosen} of ${chosen} negatives`);
    await expect(result).toContainText('Nothing was negated');

    // They are reviewable like any other proposal, in their own run — the
    // newest one, which the review screen lists first.
    await page.goto(`/recommendations?profile=${PROFILE}`);
    await page.getByText(/^Choose run/).click();
    await page.getByRole('navigation', { name: 'Runs' }).getByRole('link').first().click();
    await expect(page.locator('[data-testid^="proposal-"]')).toHaveCount(chosen);
    await expect(page.getByTestId('grid-row').first()).toContainText('Flag');
  });
});
