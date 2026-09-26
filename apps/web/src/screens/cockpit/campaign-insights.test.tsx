// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { DailyRow } from '@wizard-ads/core';
import type { DbHandle } from '@wizard-ads/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../app/_lib/periods';
import { DashboardCampaignInsights } from './load';

const mocks = vi.hoisted(() => ({ campaignRows: vi.fn(), authenticate: vi.fn() }));
vi.mock('@wizard-ads/db', () => ({ withAuthenticatedActor: mocks.authenticate }));
vi.mock('@wizard-ads/crosscheck-cli', () => ({ loadCrosscheckPanel: vi.fn() }));
vi.mock('../../../app/_lib/dashboard-data', () => ({ loadCampaignDailyRows: mocks.campaignRows, loadProfileDailyRows: vi.fn() }));

const REPORT_DATE = '2026-07-12';
const actor = { orgId: 'org-synthetic', userId: 'user-synthetic' };

/** Flat trailing week, then spend and sales triple on the report day: a spend spike only. */
function spike(campaignId: string, name: string, impressions: number): DailyRow[] {
  return Array.from({ length: 8 }, (_, index) => ({
    account: 'synthetic-acct', date: addDays(REPORT_DATE, index - 7), level: 'campaign' as const, campaignId, campaignName: name,
    impressions, clicks: 10, spend: index === 7 ? 30 : 10, sales: index === 7 ? 90 : 30, orders: 1,
  }));
}
const accountRows: DailyRow[] = Array.from({ length: 8 }, (_, index) => ({
  account: 'synthetic-acct', date: addDays(REPORT_DATE, index - 7), level: 'account' as const,
  impressions: 50_000, clicks: 500, spend: 400, sales: 1_600, orders: 40,
}));

async function renderInsights() {
  const element = await DashboardCampaignInsights({
    handle: {} as DbHandle, actor, orgId: actor.orgId, profileId: 'profile-synthetic', profileLabel: 'synthetic-acct',
    goalLens: null, analysisRows: accountRows, analysisWindow: { start: addDays(REPORT_DATE, -8), end: REPORT_DATE },
    reportDate: REPORT_DATE, pacingAlert: null, currencyCode: 'USD', period: { start: addDays(REPORT_DATE, -29), end: REPORT_DATE },
  });
  return render(element);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockImplementation(async (_handle, _actor, run) => run({}));
});

describe('cockpit flags card evidence floor', () => {
  it('passes window evidence to evaluate, so thin campaigns are floored and counted, not raised', async () => {
    mocks.campaignRows.mockResolvedValue([...spike('c-a', 'Thin A', 1), ...spike('c-b', 'Thin B', 2), ...spike('c-c', 'Busy C', 900)]);
    await renderInsights();
    expect(mocks.campaignRows).toHaveBeenCalledTimes(1);
    const card = screen.getByLabelText('Priority alerts');
    // Only the busy campaign's spike is raised; the two thin ones sit below the floor.
    expect(card.textContent).toContain('1 signal');
    expect(card.textContent).toContain('Busy C');
    expect(card.textContent).not.toContain('Thin A');
    expect(card.textContent).not.toContain('Thin B');
    expect(screen.getByTestId('flags-floored').textContent).toBe('2 signals below the evidence floor. Too few impressions or days of data in the window to raise; not counted above.');
  });

  it('shows no floored line when every signal clears the floor', async () => {
    mocks.campaignRows.mockResolvedValue(spike('c-c', 'Busy C', 900));
    await renderInsights();
    expect(screen.getByLabelText('Priority alerts').textContent).toContain('1 signal');
    expect(screen.queryByTestId('flags-floored')).toBeNull();
  });
});
