import { describe, expect, it } from 'vitest';
import { REFERENCE_METHOD, type ResolvedBidSettings } from '@wizard-ads/shared';
import { resolveCampaignMethod, resolveMethodBidSettings } from './method-settings.js';
const entity = { profileId: '22222222-2222-4222-8222-222222222222', entityType: 'keyword' as const, entityId: 'kw-synthetic' };
const groupValues = { targetAcos: 0.41, bidFloor: 0.17, bidCeiling: 3.8, bidIncreaseCap: 0.19, bidDecreaseCap: 0.57 };
const runValues = { targetAcos: 0.32, bidFloor: 0.11, bidCeiling: 4.9, bidIncreaseCap: 0.26, bidDecreaseCap: 0.62 };
const run = Object.fromEntries(Object.entries(runValues).map(([key, value]) => [key, { value, source: 'run', sourceLabel: 'This run' }])) as ResolvedBidSettings;
describe('method setting precedence', () => {
  it('uses all five group values over conflicting run fields', () => {
    const result = resolveMethodBidSettings({ entity, group: { name: 'Synthetic group', values: groupValues }, run });
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected settings');
    expect(Object.keys(result.settings)).toHaveLength(5);
    for (const key of Object.keys(groupValues) as (keyof typeof groupValues)[]) {
      expect(result.settings[key]).toEqual({ value: groupValues[key], source: 'group', sourceLabel: 'Synthetic group' });
    }
  });
  it('uses run values with no group or with no defined group values', () => {
    for (const group of [null, { name: 'Synthetic group', values: { bidFloor: null } }]) {
      expect(resolveMethodBidSettings({ entity, group, run })).toEqual({ kind: 'resolved', settings: run });
    }
  });
  it('holds every missing required field when both sources lack it', () => {
    for (const key of Object.keys(run) as (keyof ResolvedBidSettings)[]) {
      const incomplete = { ...run };
      delete (incomplete as Partial<ResolvedBidSettings>)[key];
      const result = resolveMethodBidSettings({ entity, group: null, run: incomplete });
      expect(result).toMatchObject({ kind: 'hold', hold: { reason: 'MISSING_SETTING', affectedScope: [entity] } });
      if (result.kind === 'hold') expect(result.hold.prose).toContain(key);
    }
  });
  it('retains zero caps and refuses an invalid group value instead of using the run', () => {
    expect(resolveMethodBidSettings({ entity, group: { name: 'Zero cap', values: { bidIncreaseCap: 0 } }, run })).toMatchObject({ kind: 'resolved', settings: { bidIncreaseCap: { value: 0, source: 'group' } } });
    expect(resolveMethodBidSettings({ entity, group: { name: 'Invalid ACOS', values: { targetAcos: 0 } }, run })).toMatchObject({ kind: 'hold', hold: { reason: 'MISSING_SETTING' } });
  });
  it('selects explicit campaign method, then group, then run default with its source', () => {
    expect(resolveCampaignMethod(REFERENCE_METHOD, REFERENCE_METHOD, REFERENCE_METHOD).source).toBe('run');
    expect(resolveCampaignMethod(undefined, REFERENCE_METHOD, REFERENCE_METHOD).source).toBe('group');
    expect(resolveCampaignMethod(undefined, undefined, REFERENCE_METHOD).source).toBe('default');
  });
});
