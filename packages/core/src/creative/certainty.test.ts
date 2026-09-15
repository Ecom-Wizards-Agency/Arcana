import { describe, expect, it } from 'vitest';
import { creativeChangeCertainty } from './certainty.js';

describe('recorded creative change certainty', () => {
  it('labels the earliest observation first without an invented boundary', () => {
    expect(creativeChangeCertainty({ previous: null, observedAt: '2026-06-01T12:00:00Z', firstObservation: true }))
      .toEqual({ kind: 'first', from: null, to: '2026-06-01T12:00:00.000Z', widthDays: null });
  });
  it('marks consecutive daily observations exact and missing days a window with width', () => {
    expect(creativeChangeCertainty({ previous: '2026-06-01T12:00:00Z', observedAt: '2026-06-02T12:00:00Z', firstObservation: false }))
      .toMatchObject({ kind: 'exact', widthDays: 1 });
    expect(creativeChangeCertainty({ previous: '2026-06-01T12:00:00Z', observedAt: '2026-06-05T12:00:00Z', firstObservation: false }))
      .toMatchObject({ kind: 'window', widthDays: 4 });
  });
  it('keeps missing observation boundaries explicit', () => {
    expect(creativeChangeCertainty({ previous: null, observedAt: '2026-06-05T12:00:00Z', firstObservation: false }))
      .toMatchObject({ kind: 'window', widthDays: null, from: null });
    expect(creativeChangeCertainty({ previous: '2026-06-01T12:00:00Z', observedAt: '2026-06-02T12:00:00Z', firstObservation: false, currentObserved: false }))
      .toMatchObject({ kind: 'window', widthDays: 1 });
  });
  it('uses profile calendar days across daylight saving time', () => {
    expect(creativeChangeCertainty({ previous: '2026-03-07T17:00:00Z', observedAt: '2026-03-08T16:00:00Z', firstObservation: false, timezone: 'America/New_York' }))
      .toMatchObject({ kind: 'exact', widthDays: 1 });
  });
});
