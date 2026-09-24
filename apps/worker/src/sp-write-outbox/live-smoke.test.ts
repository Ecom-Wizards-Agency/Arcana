import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SpWriteAction, SpWritePlan, serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint,
  serializeSpWriteBoundedAuthorizationFingerprint, spWritePlanBinding, type ApproveSpWritePlan,
  type SpWriteBoundedAuthorization } from '@wizard-ads/shared/sp-writes';
import { hasher } from './artifacts.js';
import { readLiveWriteAuthorization, verifyLiveWriteSmokePlans } from './live-smoke.js';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function file(value?: unknown) {
  directory = await mkdtemp(join(tmpdir(), 'wp280-smoke-'));
  await mkdir(join(directory, '_local'));
  if (value !== undefined) await writeFile(join(directory, '_local/amazon-write-authorization.json'), JSON.stringify(value));
  return directory;
}
function authorization(): SpWriteBoundedAuthorization {
  const value: SpWriteBoundedAuthorization = {
    schemaVersion: 'openspell.sp-write-bounded-authorization.v1', authorizationId: randomUUID(),
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z',
    profiles: [{ providerScope: { amazonProfileId: 'synthetic-smoke-profile', connectionId: randomUUID(),
      region: 'NA', marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' },
      allowedEntities: [{ routeKey: 'sp.v3.keywords.update', amazonEntityId: 'synthetic-keyword',
        allowedChangeKeys: ['keyword.bid'], maxAbsoluteMoneyDelta: '0.1', maxAbsolutePlacementDelta: null }] }],
    constraints: { maxLogicalChangesPerPlan: 1, maxProviderRowsPerPlan: 1, maxConcurrentMutations: 1,
      maxCycles: 1, maxExecutions: 2, requireCurrentValueMatch: true, requireForwardObservationBeforeInverse: true,
      stopOnConflict: true, disableAfterCycle: true }, fingerprint: '0'.repeat(64),
  };
  value.fingerprint = hasher.digest(serializeSpWriteBoundedAuthorizationFingerprint(value));
  return value;
}

function restoreCycle(authority: SpWriteBoundedAuthorization) {
  const sourceBatchId = randomUUID(), sourceRowId = randomUUID();
  const current = { amount: '0.7', currencyCode: 'USD' }, restoreTo = { amount: '0.75', currencyCode: 'USD' };
  const frozenAt = '2026-01-01T00:20:00.000Z';
  const fingerprintAction = (raw: unknown) => {
    const parsed = SpWriteAction.parse(raw);
    return SpWriteAction.parse({ ...parsed, fingerprint: hasher.digest(serializeSpWriteActionFingerprint(parsed)) });
  };
  const fingerprintPlan = (raw: unknown) => {
    const parsed = SpWritePlan.parse(raw);
    return SpWritePlan.parse({ ...parsed, fingerprint: hasher.digest(serializeSpWritePlanFingerprint(parsed)) });
  };
  const action = fingerprintAction({ actionId: randomUUID(), routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: 'synthetic-keyword' }, changes: { bid: { expected: current, requested: restoreTo } },
    sources: [{ kind: 'apply_row', applyRowId: sourceRowId, changeKey: 'keyword.bid' }], fingerprint: '0'.repeat(64) });
  const plan = fingerprintPlan({ schemaVersion: 'openspell.sp-write-plan.v1', id: randomUUID(),
    orgId: randomUUID(), profileId: randomUUID(), providerScope: authority.profiles[0]!.providerScope,
    direction: 'forward', generatedAt: frozenAt, frozenAt, expiresAt: authority.expiresAt,
    source: { kind: 'apply_batch', applyBatchId: sourceBatchId,
      guardrailSnapshotFingerprint: 'a'.repeat(64), provenanceSnapshotFingerprint: 'b'.repeat(64),
      restoreProposal: { kind: 'restore_proposal', sourceBatchId, sourceRowIds: [sourceRowId],
        sourceArtifactText: JSON.stringify([{ entityType: 'keyword', entityId: 'synthetic-keyword', field: 'bid', old: 0.75, new: 0.7 }]),
        rows: [{ sourceRowId, entityId: 'synthetic-keyword', current, readAt: frozenAt, restoreTo }] } },
    actions: [action], counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1, byRoute: {
      'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
      'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0,
    } }, fingerprint: '0'.repeat(64) });
  const inverseAction = fingerprintAction({ ...action, actionId: randomUUID(),
    changes: { bid: { expected: restoreTo, requested: current } },
    sources: [{ kind: 'inverse_action', sourceActionId: action.actionId, changeKey: 'keyword.bid' }] });
  const inverse = fingerprintPlan({ ...plan, id: randomUUID(), direction: 'inverse',
    source: { kind: 'inverse_execution', sourceExecutionId: randomUUID(), sourcePlanId: plan.id, sourcePlanFingerprint: plan.fingerprint },
    actions: [inverseAction] });
  const request: ApproveSpWritePlan = { approvalRequestId: randomUUID(), plan: spWritePlanBinding(plan),
    approvalMode: 'bounded_live_test', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
    boundedAuthorization: { authorizationId: authority.authorizationId, authorizationFingerprint: authority.fingerprint, expiresAt: authority.expiresAt },
    preapprovedInversePlan: spWritePlanBinding(inverse) };
  return { plan, inverse, request };
}
describe('live smoke authorization gate only; no live entry is invoked', () => {
  it('refuses a missing local authorization before runtime initialization', async () => {
    await expect(readLiveWriteAuthorization(await file())).rejects.toThrow('_local/amazon-write-authorization.json');
  });
  it('refuses malformed or altered authority', async () => {
    const value = authorization();
    value.fingerprint = 'f'.repeat(64);
    await expect(readLiveWriteAuthorization(await file(value), '2026-01-01T00:30:00.000Z')).rejects.toThrow('fingerprint mismatch');
    await writeFile(join(directory!, '_local/amazon-write-authorization.json'), '{}');
    await expect(readLiveWriteAuthorization(directory!)).rejects.toThrow();
  });
  it('accepts only the exact bounded window and retains the mandatory inverse constraints', async () => {
    const value = authorization();
    const root = await file(value);
    expect(await readLiveWriteAuthorization(root, '2026-01-01T00:30:00.000Z')).toEqual(value);
    await expect(readLiveWriteAuthorization(root, '2026-01-01T01:00:00.000Z')).rejects.toThrow('not current');
    await expect(readLiveWriteAuthorization(root, '2025-12-31T23:59:59.000Z')).rejects.toThrow('not current');
  });

  it('accepts a restore proposal and its exact inverse under the local bounded authorization without opening a provider', async () => {
    const value = authorization();
    const loaded = await readLiveWriteAuthorization(await file(value), '2026-01-01T00:30:00.000Z');
    const { plan, inverse, request } = restoreCycle(loaded);
    const verified = verifyLiveWriteSmokePlans(plan, inverse, request, loaded, '2026-01-01T00:30:00.000Z');
    expect(verified).toMatchObject({ plan, inverse, boundedAuthorization: loaded });
    expect(verified.plan.source).toMatchObject({ kind: 'apply_batch', restoreProposal: { sourceRowIds: expect.any(Array) } });
    expect(verified.plan.counts.logicalChanges + verified.inverse!.counts.logicalChanges).toBe(2);
    expect(() => verifyLiveWriteSmokePlans(plan, inverse, { ...request, approvalMode: 'manual',
      boundedAuthorization: null, preapprovedInversePlan: null }, loaded, '2026-01-01T00:30:00.000Z'))
      .toThrow('preapproved bounded');
    const outsideScope = authorization();
    expect(() => verifyLiveWriteSmokePlans(plan, inverse, request, outsideScope, '2026-01-01T00:30:00.000Z')).toThrow();
    expect(() => verifyLiveWriteSmokePlans(plan, { ...inverse, fingerprint: 'f'.repeat(64) }, request,
      loaded, '2026-01-01T00:30:00.000Z')).toThrow('fingerprint');
  });
});
