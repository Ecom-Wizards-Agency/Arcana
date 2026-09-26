import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addDays, analyzeAccount, evaluate } from '@wizard-ads/core';
import type { DailyRow, Flag } from '@wizard-ads/core';
import { evaluateFlags } from './analysis.js';

const AS_OF = '2026-07-12';

function campaign(id: string, impressions: number): DailyRow[] {
  return Array.from({ length: 8 }, (_, index) => ({
    account: 'synthetic-acct', date: addDays(AS_OF, index - 7), level: 'campaign' as const,
    campaignId: id, campaignName: `Synthetic ${id}`, category: 'Profit',
    impressions, clicks: 10, spend: index === 7 ? 30 : 10, sales: index === 7 ? 90 : 30, orders: 1,
  }));
}

const account: DailyRow[] = Array.from({ length: 8 }, (_, index) => ({
  account: 'synthetic-acct', date: addDays(AS_OF, index - 7), level: 'account' as const,
  impressions: 50_000, clicks: 500, spend: 400, sales: 1_600, orders: 40,
}));

describe('get_flags evidence floor', () => {
  it('holds back a signal read on almost no impressions and counts it', () => {
    const result = evaluateFlags('synthetic-acct', AS_OF, account, [...campaign('thin', 1), ...campaign('busy', 900)], null);
    expect(result.active.map((flag) => flag.scope)).toEqual(['Synthetic busy']);
    expect(result.floored).toHaveLength(1);
    expect(result.floored[0]?.flag.scope).toBe('Synthetic thin');
    expect(result.floored[0]?.family).toBe('spend_spike');
  });

  it('returns the golden output unchanged for every unconfigured golden case above the floor', () => {
    const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/golden/flags.json', import.meta.url)), 'utf8')) as {
      fixtures: Record<string, { account: string; reportDate: string; accountRows: DailyRow[]; campaignRows: DailyRow[]; metrics: string[] | null }>;
      cases: { name: string; input: { fixture: string; config: unknown; goal: string | null }; expected: { active: Flag[]; suppressed: Flag[] } }[];
    };
    let compared = 0;
    for (const c of golden.cases) {
      const fixture = golden.fixtures[c.input.fixture]!;
      if (c.input.config !== null || fixture.metrics !== null) continue;
      const result = evaluateFlags(fixture.account, fixture.reportDate, fixture.accountRows, fixture.campaignRows, c.input.goal);
      expect(result.floored, c.name).toHaveLength(0);
      expect(result.active, c.name).toEqual(c.expected.active);
      expect(result.suppressed, c.name).toEqual(c.expected.suppressed);
      const unfloored = evaluate(analyzeAccount(fixture.account, fixture.reportDate, fixture.accountRows, fixture.campaignRows), null, c.input.goal);
      expect(JSON.stringify(result.active), c.name).toBe(JSON.stringify(unfloored.active));
      compared += 1;
    }
    expect(compared).toBe(golden.cases.filter((c) => c.input.config === null && golden.fixtures[c.input.fixture]!.metrics === null).length);
    expect(compared).toBe(18);
  });
});
