import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState, BASE_URL } from './support/fixture';

test('translation preserves the original, persists language and retries through authenticated admission', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId, connectionString } = await readState();
  await page.goto(`/grid?entity=targets&profile=${fixtureProfileId}`);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: /^Columns \(/ }).click();
  await expect(page.getByText('Translation · Hidden by default')).toBeVisible();
  await page.getByLabel('Translation language', { exact: true }).selectOption('de');
  await page.getByRole('button', { name: 'Add Translation', exact: true }).click();
  await page.getByRole('button', { name: 'Close controls', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Translation', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Target', exact: true })).toBeVisible();
  await expect(page.getByText('Use the original wording when editing a target. Translation helps you read it.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Translation status', exact: true })).toHaveAttribute('href', `/grid/translation?profile=${fixtureProfileId}&language=de`);
  await page.getByRole('button', { name: 'Hide Translation', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Translation', exact: true })).toHaveCount(0);
  const queued = await page.request.post('/api/translation', { headers: { Origin: BASE_URL }, data: { profileId: fixtureProfileId, originalText: 'Synthetic translated term', language: 'en' } });
  expect(queued.status()).toBe(200);
  const { row } = await queued.json() as { row: { id: string; provenance: { requestId: string } } };
  const database = createDb({ connectionString, max: 1 });
  try {
    await database.sql`update public.target_translations set status='unavailable', reason='provider not configured', completed_at=now() where id=${row.id}`;
    await page.goto(`/grid/translation?profile=${fixtureProfileId}&language=en`);
    const status = page.getByTestId('translation-status-row').filter({ hasText: 'Synthetic translated term' });
    await expect(status).toContainText('Translation unavailable');
    await status.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(status).toContainText('Waiting');
    const jobs = await database.sql<{ count: number }[]>`select count(*)::int as count from public.sync_jobs where payload->>'translationId'=${row.id}`;
    expect(jobs[0]?.count).toBe(2);
    await database.sql`update public.target_translations set status='unavailable', reason='provider not configured', completed_at=now() where id=${row.id}`;
    await page.getByRole('button', { name: 'Refresh translations', exact: true }).click();
    await expect(status).toContainText('Translation unavailable');
    await expect(page.getByRole('link', { name: 'Back to targets' })).toBeVisible();
  } finally { await database.close(); }
});

test('translation refuses anonymous and foreign-agency mutations', async ({ page }) => {
  const { fixtureProfileId } = await readState();
  expect((await page.request.post('/api/translation', { headers: { Origin: BASE_URL }, data: { profileId: fixtureProfileId, originalText: 'Synthetic foreign term', language: 'en' } })).status()).toBe(401);
  await signIn(page, 'outsider');
  const refused = await page.request.post('/api/translation', { headers: { Origin: BASE_URL }, data: { profileId: fixtureProfileId, originalText: 'Synthetic foreign term', language: 'en' } });
  expect([403, 404]).toContain(refused.status());
});
