import { describe, expect, it } from 'vitest';
import { calculateCampaignStartingBid, campaignBidRationale } from './bid.js';
import type { CampaignBuilderBidEvidence } from '@wizard-ads/shared';
const evidence: CampaignBuilderBidEvidence = { keyword: 'synthetic keyword', clicks: 160, spend: 96, reportedCpc: 0.6, days: 30, sourceRows: 30,
  start: '2026-05-01', end: '2026-05-30', source: 'fact_sp_target_daily', sales: 320 };
const input = { basis: 'keyword_cpc' as const, manualBid: null, evidence, topOfSearch: 140, audienceAdjustment: 40,
  bounds: { floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 } };
describe('starting bid evidence and exposure', () => {
  it('divides CPC by placement and compounds audience exposure', () => {
    const result = calculateCampaignStartingBid(input);
    expect(result.rawBase).toBeCloseTo(0.6 / 2.4);
    expect(result.exposure).toBeCloseTo(result.base! * 2.4 * 1.4);
    expect(result.reconciled).toBe(true); expect(result.usable).toBe(true);
  });
  it('clamps the suggestion to supplied floor and ceiling', () => {
    expect(calculateCampaignStartingBid({ ...input, bounds: { ...input.bounds, floor: 0.3 } }).base).toBe(0.3);
    expect(calculateCampaignStartingBid({ ...input, bounds: { ...input.bounds, ceiling: 0.2 } }).base).toBe(0.2);
  });
  it('blocks exact entered exposure even when the base fits its range', () => {
    const result = calculateCampaignStartingBid({ ...input, basis: 'manual', manualBid: 0.9 });
    expect(result.inRange).toBe(true); expect(result.exceeded).toBe(true); expect(result.usable).toBe(false);
  });
  it('does not silently clamp an invalid operator amount into approval', () => {
    expect(calculateCampaignStartingBid({ ...input, basis: 'manual', manualBid: 4 }).usable).toBe(false);
    expect(calculateCampaignStartingBid({ ...input, basis: 'manual', manualBid: 0.333 }).inRange).toBe(false);
  });
  it('detects inconsistent source totals with currency rounding tolerance', () => {
    expect(calculateCampaignStartingBid({ ...input, evidence: { ...evidence, reportedCpc: 0.604 } }).reconciled).toBe(true);
    const mismatch = calculateCampaignStartingBid({ ...input, evidence: { ...evidence, reportedCpc: 0.87 } });
    expect(mismatch.reconciled).toBe(false); expect(mismatch.base).toBeNull(); expect(mismatch.usable).toBe(false);
  });
  it('keeps missing reported CPC, zero clicks and missing bounds unavailable', () => {
    expect(calculateCampaignStartingBid({ ...input, evidence: { ...evidence, reportedCpc: null } }).reconciled).toBeNull();
    expect(calculateCampaignStartingBid({ ...input, evidence: { ...evidence, clicks: 0 } }).cpc).toBeNull();
    expect(calculateCampaignStartingBid({ ...input, bounds: { ...input.bounds, exposureCeiling: null } }).usable).toBe(false);
  });
  it('creates a sentence from the supplied inputs for storage', () => {
    const value = { keyword: evidence.keyword, basis: 'manual' as const, bid: 0.36, currency: 'USD', topOfSearch: 140, audienceAdjustment: 40, evidence };
    const stored = campaignBidRationale(value);
    expect(stored).toContain('1.2096 exposure');
    value.topOfSearch = 200;
    expect(stored).toContain('140%'); expect(campaignBidRationale(value)).not.toBe(stored);
  });
});
