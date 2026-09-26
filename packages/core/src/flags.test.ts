import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { analyzeAccount } from './analyze.js';
import {
  DEFAULT_THRESHOLDS,
  FLAG_ISSUES,
  evaluate,
  evaluationWindow,
  flagIssue,
  groupFlagsByIssue,
  windowEvidence,
  type FlagContext,
  type FlagFamily,
  type FlagsConfig,
} from './flags.js';
import { addDays } from './rows.js';
import type { DailyRow, Flag, Severity } from './types.js';

const REPORT_DATE = '2026-07-12';

interface DayShape {
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
}

/** Eight days ending on the report date; the last shape is the report day. */
function campaignRows(campaignId: string, name: string, shapes: DayShape[], category = 'Profit'): DailyRow[] {
  return shapes.map((shape, index) => ({
    account: 'synthetic-acct',
    date: addDays(REPORT_DATE, index - (shapes.length - 1)),
    level: 'campaign' as const,
    campaignId,
    campaignName: name,
    category,
    ...shape,
  }));
}

function accountRows(days = 8): DailyRow[] {
  return Array.from({ length: days }, (_, index) => ({
    account: 'synthetic-acct',
    date: addDays(REPORT_DATE, index - (days - 1)),
    level: 'account' as const,
    impressions: 50_000,
    clicks: 500,
    spend: 400,
    sales: 1_600,
    orders: 40,
  }));
}

/** Flat trailing week, then spend and sales triple on the report day: a spend spike only. */
function spikeShapes(impressions: number, days = 8): DayShape[] {
  const flat = { impressions, clicks: 10, spend: 10, sales: 30, orders: 1 };
  return [...Array.from({ length: days - 1 }, () => flat), { impressions, clicks: 10, spend: 30, sales: 90, orders: 1 }];
}

function run(rows: DailyRow[], options: { evidence?: boolean; config?: FlagsConfig | null } = {}) {
  const account = accountRows();
  const analysis = analyzeAccount('synthetic-acct', REPORT_DATE, account, rows);
  const evidence = options.evidence === false ? null : windowEvidence(REPORT_DATE, account, rows);
  return evaluate(analysis, options.config ?? null, null, evidence);
}

describe('evidence floor', () => {
  it('floors a spend spike read on a couple of impressions a day and returns it for counting', () => {
    const result = run(campaignRows('c-thin', 'Thin campaign', spikeShapes(1)));
    expect(result.active).toHaveLength(0);
    expect(result.activeContext).toHaveLength(0);
    expect(result.floored).toHaveLength(1);
    const [floored] = result.floored;
    expect(floored?.family).toBe('spend_spike');
    expect(floored?.campaignId).toBe('c-thin');
    expect(floored?.flag.scope).toBe('Thin campaign');
    expect(floored?.evidence).toEqual({
      impressions: 8,
      days: 8,
      window: { start: '2026-07-05', end: REPORT_DATE },
      source: 'rows',
    });
    expect(floored?.floor).toEqual({
      minImpressions: DEFAULT_THRESHOLDS.floor_spend_spike_min_impressions,
      minDays: DEFAULT_THRESHOLDS.floor_spend_spike_min_days,
    });
  });

  it('raises the same spike once the window clears the impressions floor', () => {
    const result = run(campaignRows('c-real', 'Real campaign', spikeShapes(500)));
    expect(result.floored).toHaveLength(0);
    expect(result.active).toHaveLength(1);
    expect(result.activeContext.map((context) => [context.family, context.campaignId])).toEqual([['spend_spike', 'c-real']]);
    expect(result.activeContext[0]?.evidence).toMatchObject({ impressions: 4_000, days: 8, source: 'rows' });
  });

  it('floors on too few days of data even when impressions are plentiful', () => {
    const result = run(campaignRows('c-new', 'New campaign', spikeShapes(5_000, 2)));
    expect(result.active).toHaveLength(0);
    expect(result.floored).toHaveLength(1);
    expect(result.floored[0]?.evidence).toMatchObject({ impressions: 10_000, days: 2 });
  });

  it('lets per-account config move a family floor, lowest to highest like every threshold', () => {
    const rows = campaignRows('c-thin', 'Thin campaign', spikeShapes(1));
    const result = run(rows, { config: { thresholds: { floor_spend_spike_min_impressions: 0 } } });
    expect(result.floored).toHaveLength(0);
    expect(result.active).toHaveLength(1);
  });

  it('counts each floored signal separately across campaigns and keeps raised ones', () => {
    const rows = [
      ...campaignRows('c-a', 'Thin A', spikeShapes(1)),
      ...campaignRows('c-b', 'Thin B', spikeShapes(2)),
      ...campaignRows('c-c', 'Busy C', spikeShapes(900)),
    ];
    const result = run(rows);
    expect(result.floored.map((item) => item.flag.scope)).toEqual(['Thin A', 'Thin B']);
    expect(result.active.map((item) => item.scope)).toEqual(['Busy C']);
  });

  it('applies no floor without row evidence, so a caller that cannot count floored signals loses none', () => {
    const thin = run(campaignRows('c-thin', 'Thin campaign', spikeShapes(1)), { evidence: false });
    expect(thin.floored).toHaveLength(0);
    expect(thin.active).toHaveLength(1);
    expect(thin.activeContext[0]?.evidence).toMatchObject({ impressions: 8, days: 8, source: 'inferred' });
    const covered = run(campaignRows('c-real', 'Real campaign', spikeShapes(500)), { evidence: false });
    expect(covered.activeContext[0]?.evidence).toMatchObject({ impressions: 4_000, days: 8, source: 'inferred' });
  });

  it('never treats unreported impressions as zero', () => {
    const rows = campaignRows('c-x', 'Unmeasured campaign', spikeShapes(900));
    const account = accountRows();
    const analysis = analyzeAccount('synthetic-acct', REPORT_DATE, account, rows);
    const result = evaluate(analysis, null, null, {
      account: { impressions: null, days: 8 },
      campaigns: { 'c-x': { impressions: null, days: 8 } },
    });
    expect(result.floored).toHaveLength(0);
    expect(result.active).toHaveLength(1);
  });

  it('uses the report day and the seven days before it as the window', () => {
    expect(evaluationWindow(REPORT_DATE)).toEqual({ start: '2026-07-05', end: REPORT_DATE });
    const early = campaignRows('c-a', 'A', spikeShapes(40, 8));
    const outside = { ...early[0]!, date: '2026-07-01', impressions: 10_000 };
    expect(windowEvidence(REPORT_DATE, [], [...early, outside]).campaigns['c-a']).toEqual({ impressions: 320, days: 8 });
  });
});

interface GoldenCase {
  name: string;
  input: { fixture: string; config: FlagsConfig | null; goal: string | null };
  expected: { active: Flag[]; suppressed: Flag[] };
}

interface GoldenFixture {
  account: string;
  reportDate: string;
  accountRows: DailyRow[];
  campaignRows: DailyRow[];
  metrics: string[] | null;
}

describe('existing fixtures stay above the floor', () => {
  const golden = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../fixtures/golden/flags.json', import.meta.url)), 'utf8'),
  ) as { fixtures: Record<string, GoldenFixture>; cases: GoldenCase[] };

  it('produces byte-identical active and suppressed flags with exact row evidence for every golden case', () => {
    let compared = 0;
    for (const c of golden.cases) {
      const fixture = golden.fixtures[c.input.fixture]!;
      const analysis = analyzeAccount(
        fixture.account,
        fixture.reportDate,
        fixture.accountRows,
        fixture.campaignRows,
        fixture.metrics ?? undefined,
      );
      const inferred = evaluate(analysis, c.input.config, c.input.goal);
      const exact = evaluate(
        analysis,
        c.input.config,
        c.input.goal,
        windowEvidence(fixture.reportDate, fixture.accountRows, fixture.campaignRows),
      );
      expect(JSON.stringify(exact.active), c.name).toBe(JSON.stringify(inferred.active));
      expect(JSON.stringify(exact.suppressed), c.name).toBe(JSON.stringify(inferred.suppressed));
      expect(exact.floored, c.name).toHaveLength(0);
      expect(inferred.floored, c.name).toHaveLength(0);
      expect(exact.active.length, c.name).toBe(c.expected.active.length);
      expect(exact.activeContext.map((context) => context.flag)).toEqual(exact.active);
      expect(exact.suppressedContext.map((context) => context.flag)).toEqual(exact.suppressed);
      compared += 1;
    }
    expect(compared).toBe(golden.cases.length);
    expect(compared).toBe(54);
  });

  it('names the family behind each flag of the campaign fixture', () => {
    const fixture = golden.fixtures['campaign_fixture']!;
    const analysis = analyzeAccount(fixture.account, fixture.reportDate, fixture.accountRows, fixture.campaignRows);
    const result = evaluate(analysis, null, null, windowEvidence(fixture.reportDate, fixture.accountRows, fixture.campaignRows));
    expect(result.activeContext.map((context) => `${context.family}:${context.campaignId ?? 'account'}`)).toEqual([
      'zero_sales_spend:D',
      'near_zero_impressions:C',
      'cvr_drop:B',
      'spend_collapse:C',
      'budget_capped:E',
      'discovery_share:account',
      'cvr_drop:account',
      'acos_swing:B',
      'acos_swing:account',
    ]);
    expect(result.suppressedContext.map((context) => context.family)).toEqual(['acos_swing']);
  });
});

function context(family: FlagFamily, severity: Severity, scope: string): FlagContext {
  return {
    family,
    campaignId: scope === 'account' ? null : scope,
    evidence: { impressions: 1_000, days: 8, window: evaluationWindow(REPORT_DATE), source: 'rows' },
    flag: {
      severity,
      metric: 'synthetic',
      threshold: 'synthetic',
      message: `${family} on ${scope}`,
      likelyCause: 'synthetic',
      scope,
      category: 'Profit',
      suppressed: false,
      suppressedReason: null,
    },
  };
}

describe('issue grouping', () => {
  it('places every flag family in exactly one issue', () => {
    const families: FlagFamily[] = [
      'spend_spike', 'spend_collapse', 'budget_capped', 'cvr_drop', 'near_zero_impressions',
      'zero_sales_spend', 'acos_swing', 'discovery_share', 'tacos_margin', 'pacing',
    ];
    const mapped = FLAG_ISSUES.flatMap((issue) => issue.families);
    expect(mapped).toHaveLength(families.length);
    expect(new Set(mapped)).toEqual(new Set(families));
    expect(FLAG_ISSUES).toHaveLength(10);
    expect(flagIssue('zero_sales_spend').label).toBe('Spend with no sales');
  });

  it('groups by issue, leads with the most severe group, then the fixed issue priority', () => {
    const groups = groupFlagsByIssue([
      context('acos_swing', 'info', 'c-1'),
      context('spend_spike', 'warn', 'c-2'),
      context('zero_sales_spend', 'alert', 'c-3'),
      context('budget_capped', 'warn', 'c-4'),
      context('spend_spike', 'alert', 'c-5'),
      context('zero_sales_spend', 'warn', 'c-6'),
    ]);
    expect(groups.map((group) => [group.label, group.severity, group.items.length])).toEqual([
      ['Spend with no sales', 'alert', 2],
      ['Spend rising sharply', 'alert', 2],
      ['Capped by daily budget', 'warn', 1],
      ['ACOS swinging against the trailing week', 'info', 1],
    ]);
    expect(groups[1]?.items.map((item) => item.flag.scope)).toEqual(['c-2', 'c-5']);
    expect(groups.reduce((total, group) => total + group.items.length, 0)).toBe(6);
  });
});
