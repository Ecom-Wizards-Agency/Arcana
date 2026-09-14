import { describe, expect, it } from 'vitest';
import { TargetTranslation, TranslationLanguage, TranslationRequest, TranslationStatus } from './translation.js';
import { GridSavedView, parseGridView, serializeGridView } from './grid-views.js';
import { JobPayload } from './jobs.js';

const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
describe('translation contracts', () => {
  it('defaults to English without changing original wording', () => {
    const request = TranslationRequest.parse({ profileId: uuid('1'), originalText: '  synthetic wording  ' });
    expect(request.language).toBe('en');
    expect(request.originalText).toBe('  synthetic wording  ');
    expect(TranslationRequest.safeParse({ ...request, originalText: ' ' }).success).toBe(false);
    expect(TranslationRequest.safeParse({ ...request, orgId: uuid('2') }).success).toBe(false);
  });
  it.each(TranslationLanguage.options)('accepts language %s', (language) => expect(TranslationLanguage.parse(language)).toBe(language));
  it.each([
    { status: 'waiting', text: null, reason: null },
    { status: 'available', text: 'Synthetic translation', reason: null },
    { status: 'unavailable', text: null, reason: 'provider not configured' },
  ])('preserves the $status state and provenance', (result) => {
    const row = TargetTranslation.parse({ id: uuid('1'), orgId: uuid('2'), profileId: uuid('3'), originalText: 'Synthetic original', language: 'en', providerId: 'not-configured', result,
      provenance: { requestedAt: '2026-01-01T00:00:00.000Z', completedAt: null, requestedBy: uuid('4'), requestId: uuid('5') } });
    expect(row.result).toEqual(result);
  });
  it('refuses contradictory and unexplained states', () => {
    for (const result of [
      { status: 'available', text: null, reason: null }, { status: 'unavailable', text: null, reason: '' },
      { status: 'waiting', text: 'invented', reason: null }, { status: 'available', text: 'word', reason: 'error' },
    ]) expect(TranslationStatus.safeParse(result).success).toBe(false);
  });
  it('admits scoped attempt identity and refuses a missing scope', () => {
    const job = { type: 'translation.request', orgId: uuid('1'), profileId: uuid('2'), translationId: uuid('3'), requestId: uuid('4') };
    expect(JobPayload.parse(job)).toEqual(job);
    expect(JobPayload.safeParse({ ...job, orgId: undefined }).success).toBe(false);
  });
  it('round trips chart and language without changing other view state', () => {
    const view = GridSavedView.parse({ id: 'fixture', name: 'Fixture', entity: 'targets', columns: ['targeting', 'translation'], pinned: ['targeting'], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '2026-01-01', chart: { series: ['spend', 'sales'] }, translation: { language: 'de' } });
    expect(parseGridView(serializeGridView(view))).toEqual(view);
    expect(GridSavedView.safeParse({ ...view, chart: { series: ['spend', 'spend'] } }).success).toBe(false);
    expect(GridSavedView.safeParse({ ...view, chart: { series: ['spend', 'sales', 'clicks', 'cpc', 'acos'] } }).success).toBe(false);
  });
});
