import { describe, expect, it } from 'vitest';
import { BrandLensOverrideInput } from './brand-lens.js';
import { DaypartingModifiers, DaypartingDraftInput, DaypartingReviewInput } from './dayparting.js';
const profileId = '11111111-1111-4111-8111-111111111111';
const modifiers = () => Array.from({ length: 7 }, () => Array<number>(24).fill(0));
describe('research contracts', () => {
  it('requires all 168 bounded whole percentages', () => {
    expect(DaypartingModifiers.parse(modifiers()).flat()).toHaveLength(168);
    for (const value of [-100, 301, 0.5, NaN]) {
      const grid = modifiers();
      grid[0]![0] = value;
      expect(DaypartingModifiers.safeParse(grid).success).toBe(false);
    }
    expect(DaypartingModifiers.safeParse(modifiers().slice(1)).success).toBe(false);
  });
  it('never accepts execution state or caller-supplied review authority', () => {
    const draft = {
      profileId,
      name: 'Synthetic schedule',
      modifiers: modifiers(),
      campaignIds: ['synthetic-campaign']
    };
    expect(DaypartingDraftInput.safeParse(draft).success).toBe(true);
    for (const status of ['enabled', 'paused', 'reviewed']) expect(DaypartingDraftInput.safeParse({
      ...draft,
      status
    }).success).toBe(false);
    expect(DaypartingDraftInput.safeParse({
      ...draft,
      campaignIds: ['duplicate', 'duplicate']
    }).success).toBe(false);
    expect(DaypartingReviewInput.safeParse({
      profileId,
      id: profileId,
      expectedUpdatedAt: '2026-07-01T00:00:00Z',
      evidenceStart: '2026-07-01',
      evidenceEnd: '2026-07-08',
      evidenceFingerprint: 'synthetic',
      reviewedBy: profileId
    }).success).toBe(false);
  });
  it('keeps override choices explicit', () => {
    expect(BrandLensOverrideInput.parse({
      profileId,
      keyword: ' Synthetic term ',
      bucket: 'generic',
      decision: 'kept'
    }).keyword).toBe('Synthetic term');
  });
});
