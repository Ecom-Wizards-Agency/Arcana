import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySpWriteInversePair, verifySpWritePlanFingerprints } from '@wizard-ads/shared/sp-writes';
import { spWriteApprovalFixtures, spWriteTwoChangeApprovalFixture } from './approval-fixtures';

describe('approval presentation fixtures', () => {
  it('fingerprints both selected changes and reconciles their saved evidence', async () => {
    const single = (await spWriteApprovalFixtures()).ready;
    const both = await spWriteTwoChangeApprovalFixture(single);
    const plan = verifySpWritePlanFingerprints(both.preview.plan, {
      algorithm: 'sha256', digest: (value) => createHash('sha256').update(value).digest('hex'),
    });
    expect(plan.counts).toMatchObject({ logicalChanges: 2, providerRows: 2, uniqueEntities: 2 });
    expect(plan.actions).toHaveLength(2);
    expect(both.currentRows).toHaveLength(2);
    const evidence = both.preview.evidence;
    if (!evidence || evidence.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') throw new Error('Expected synthetic forward evidence');
    expect(evidence.provenance.rows).toHaveLength(2);
    expect(evidence.guardrails.policies).toHaveLength(2);
    expect(single.preview.plan.counts.logicalChanges).toBe(1);
  });
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
