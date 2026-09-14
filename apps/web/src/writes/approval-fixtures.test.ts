import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySpWriteInversePair, verifySpWritePlanFingerprints } from '@wizard-ads/shared/sp-writes';
import { spWriteApprovalFixtures } from './approval-fixtures';

describe('approval presentation fixtures', () => {
  it('keeps hashed frozen evidence unchanged across refresh and uncertain-response scenarios', async () => {
    const fixtures = await spWriteApprovalFixtures();
    const plan = verifySpWritePlanFingerprints(fixtures.ready.preview.plan, {
      algorithm: 'sha256', digest: (value) => createHash('sha256').update(value).digest('hex'),
    });
    for (const fixture of [fixtures.stale, fixtures.unavailable, fixtures.queued]) {
      expect(fixture.preview).toEqual(fixtures.ready.preview);
      expect(fixture.currentRows).toHaveLength(plan.counts.providerRows);
    }
    expect(fixtures.stale.currentRows).not.toEqual(fixtures.ready.currentRows);
    expect(fixtures.lostResponse[1]?.body).toEqual(fixtures.queued.admission);
    verifySpWriteInversePair(fixtures.ready.preview.plan, fixtures.inverse.preview.plan, {
      algorithm: 'sha256', digest: (value) => createHash('sha256').update(value).digest('hex'),
    });
  });
});
