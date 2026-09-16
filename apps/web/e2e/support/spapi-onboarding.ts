import { expect, type Page } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MOCK_PORT, readState } from './fixture';

export async function exerciseSpApiReadOnlyRole(page: Page, role: 'viewer' | 'analyst'): Promise<void> {
  await page.goto('/settings/connections');
  const section = page.getByTestId('spapi-connections');
  await expect(section).toContainText('Connecting Seller Central requires the admin or owner role.');
  await expect(section.getByRole('checkbox')).toHaveCount(0);
  await expect(section.getByRole('button',{ name: /Connect Seller Central|Reconnect seller account|Revoke seller connection/ })).toHaveCount(0);
  const state = await readState();
  const response = await page.request.post('/api/amazon/spapi/oauth/start',{
    headers: { origin: new URL(page.url()).origin },
    form: { org: state.orgId,label: 'Forbidden seller',binding: `${state.fixtureProfileId}:ATVPDKIKX0DER` },maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
  const scratch = resolve(process.cwd(), 'node_modules', '.cache', 'wp300-scratch');
  const directory = join(scratch,'tmp','screenshots'); await mkdir(directory,{ recursive: true });
  await section.screenshot({ path: join(directory,`spapi-${role}.png`) });
}

/** Extends the existing connected-account browser scenario through SP custody. */
export async function exerciseSpApiOnboarding(page: Page): Promise<void> {
  const scratch = resolve(process.cwd(), 'node_modules', '.cache', 'wp300-scratch');
  const screenshots = join(scratch,'tmp','screenshots'); await mkdir(screenshots,{ recursive: true });
  const capture = async (name: string): Promise<void> => { await page.getByTestId('spapi-connections').screenshot({ path: join(screenshots,`${name}.png`) }); };
  const mode = async (value: string): Promise<void> => {
    const response = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/spapi`,{ form: { mode: value } }); expect(response.ok()).toBe(true);
  };
  await page.goto('/settings/connections');
  const section = page.getByTestId('spapi-connections');
  await expect(section.getByRole('checkbox',{ name: /EU storefront/ })).toHaveCount(0);
  await capture('spapi-configured');
  const start = async (): Promise<void> => {
    await section.getByRole('textbox',{ name: 'Seller connection label' }).fill('Synthetic seller connection');
    await section.getByRole('checkbox',{ name: /NA storefront 1/ }).check();
    await section.getByTestId('connect-spapi').click();
    await expect(page.getByTestId('spapi-progress')).toBeVisible();
  };
  await start();
  await expect(page.getByTestId('spapi-progress')).toContainText('Seller account connected');
  await expect(page.getByTestId('spapi-progress')).toContainText('1 of 1 selected profiles attached');
  const row = section.getByTestId('spapi-connection-row').filter({ hasText: 'Synthetic seller connection' });
  await expect(row).toContainText('1 profile · 0 bindings enabled');
  await capture('spapi-active-disabled');
  const state = await readState(); const handle = createDb({ connectionString: state.connectionString,max: 1 });
  try {
    expect(await handle.sql`select id from public.spapi_connections where org_id=${state.orgId} and label='Synthetic seller connection'`).toHaveLength(1);
    expect(await handle.sql`select b.enabled,p.sync_enabled from public.spapi_profile_bindings b join public.ad_profiles p on p.id=b.profile_id
      join public.spapi_connections c on c.id=b.connection_id where c.org_id=${state.orgId} and c.label='Synthetic seller connection'`)
      .toEqual([{ enabled: false,sync_enabled: false }]);
    expect(await handle.sql`select c.id from public.spapi_connections c join vault.secrets s on s.id=c.vault_secret_id
      where c.org_id=${state.orgId} and c.label='Synthetic seller connection'`).toHaveLength(1);
    const counts = await (await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/calls`)).json();
    expect(counts.spConsents).toBe(1); expect(counts.spExchanges).toBe(1);
    await page.reload();
    expect((await (await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/calls`)).json()).spExchanges).toBe(1);

    await mode('hold'); await start();
    await expect(page.getByTestId('spapi-progress')).toContainText('Connecting seller account');
    await capture('spapi-pending');
    await page.getByRole('button',{ name: 'Cancel seller connection' }).click();
    await expect(page.getByTestId('spapi-progress')).toContainText('Seller connection cancelled');
    await capture('spapi-cancelled'); await mode('success');
    await mode('refuse'); await start();
    await expect(page.getByTestId('spapi-progress')).toContainText('Seller account needs reconnecting');
    await expect(page.getByTestId('spapi-progress')).toContainText('Amazon refused');
    await capture('spapi-reconnect-required'); await mode('success');
    await row.getByRole('button',{ name: 'Check seller connection' }).click();
    await expect(section.getByRole('status')).toContainText('active');
    await row.getByRole('button',{ name: 'Revoke seller connection',exact: true }).click();
    await row.getByRole('button',{ name: 'Yes, revoke seller connection' }).click();
    await expect(row).toContainText('revoked'); await capture('spapi-revoked');
    expect(await handle.sql`select vault_secret_id from public.spapi_connections where org_id=${state.orgId} and label='Synthetic seller connection'`)
      .toEqual([{ vault_secret_id: null }]);
    const final = await (await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/calls`)).json();
    expect(final.spConsents).toBe(3); expect(final.spExchanges).toBe(3);
    expect(await handle.sql`select state from app.spapi_connection_operations where org_id=${state.orgId} order by created_at`)
      .toEqual([{ state: 'completed' },{ state: 'cancelled' },{ state: 'reconnect_required' }]);
  } finally { await mode('success'); await handle.close(); }
}
