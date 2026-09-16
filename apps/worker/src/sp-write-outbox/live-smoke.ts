/** Explicit operator entry for an already recorded, preapproved forward/inverse cycle. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, connectionStringFromEnv } from '@wizard-ads/db';
import { createSpWriteRuntimeLedger, type LoadVerifiedSpWriteExecutionIdentity } from '@wizard-ads/db/sp-write-persistence';
import { readSpWriteDatabaseTime, reconcileSpWriteObservation } from '@wizard-ads/db/sp-write-worker';
import { Uuid } from '@wizard-ads/shared';
import { verifySpWriteApprovalArtifacts, verifySpWriteBoundedAuthorizationFingerprint,
  type ApproveSpWritePlan, type SpWriteBoundedAuthorization, type SpWritePlan } from '@wizard-ads/shared/sp-writes';
import { hasher } from './artifacts.js';
import { createSpWriteOutboxLoop } from './loop.js';
import { spWritePolicyFromEnv } from './policy.js';
import { createSpWriteProviderPreparation } from './providers.js';

/** Read and validate local authority before opening SQL or constructing a provider. */
export async function readLiveWriteAuthorization(root: string, now = new Date().toISOString()) {
  let text: string;
  try { text = await readFile(resolve(root, '_local/amazon-write-authorization.json'), 'utf8'); }
  catch { throw new Error('Live smoke requires _local/amazon-write-authorization.json'); }
  const authorization = verifySpWriteBoundedAuthorizationFingerprint(JSON.parse(text), hasher);
  if (Date.parse(now) < Date.parse(authorization.issuedAt) || Date.parse(now) >= Date.parse(authorization.expiresAt)) {
    throw new Error('Live smoke authorization is not current');
  }
  if (authorization.profiles.some((profile) => profile.allowedEntities.some((entity) =>
    entity.routeKey !== 'sp.v3.keywords.update' || entity.allowedChangeKeys.length !== 1
    || entity.allowedChangeKeys[0] !== 'keyword.bid'))) throw new Error('Live smoke supports exact keyword bid cycles only');
  return authorization;
}

/** Shared with the offline proof; restore proposals remain forward plans with their own exact inverse. */
export function verifyLiveWriteSmokePlans(plan: SpWritePlan, inverse: SpWritePlan, request: ApproveSpWritePlan,
  authorization: SpWriteBoundedAuthorization, now: string) {
  if (plan.direction !== 'forward' || request.approvalMode !== 'bounded_live_test'
    || request.preapprovedInversePlan === null) throw new Error('A preapproved bounded forward/inverse receipt is required');
  return verifySpWriteApprovalArtifacts(plan, inverse, request, authorization, now, hasher);
}

/** This entry never issues approval, changes gates, or admits an unrelated plan. */
export async function runLiveWriteSmoke(root: string, identity: LoadVerifiedSpWriteExecutionIdentity,
  env: NodeJS.ProcessEnv = process.env) {
  const authorization = await readLiveWriteAuthorization(root);
  if (env['OPENSPELL_SP_WRITE_SMOKE_EXCLUSIVE'] !== '1') throw new Error('Stop the general write poller and attest exclusive smoke ownership');
  const policy = spWritePolicyFromEnv(env);
  if (!policy.dispatchEnabled || !policy.reconcileEnabled || !policy.profileIds.includes(identity.profileId)) {
    throw new Error('Live smoke requires both runtime gates and the exact profile allowlist');
  }
  const database = createDb({ connectionString: connectionStringFromEnv(env), max: 4 });
  let loop: ReturnType<typeof createSpWriteOutboxLoop> | undefined;
  try {
    const runtime = createSpWriteRuntimeLedger(database);
    const forward = await runtime.loadVerifiedExecution(identity);
    if (forward === null || forward.plan.direction !== 'forward' || forward.authorization.approvalMode !== 'bounded_live_test'
      || forward.authorization.preapprovedInversePlan === null) throw new Error('A preapproved bounded forward/inverse receipt is required');
    const inverseId = forward.authorization.preapprovedInversePlan.planId;
    const inverseIdentity = { ...identity, planId: inverseId };
    const inverse = await runtime.loadVerifiedExecution(inverseIdentity);
    if (inverse === null) throw new Error('The immutable preapproved inverse is missing');
    const receipt = forward.authorization;
    verifyLiveWriteSmokePlans(forward.plan, inverse.plan, {
      approvalRequestId: receipt.approvalRequestId, plan: receipt.plan, approvalMode: receipt.approvalMode,
      confirmationVersion: receipt.confirmationVersion, boundedAuthorization: receipt.boundedAuthorization,
      preapprovedInversePlan: receipt.preapprovedInversePlan,
    }, authorization, await readSpWriteDatabaseTime(database));
    loop = createSpWriteOutboxLoop({ database, claimantId: 'authorized-live-write-smoke',
      policy: () => { const current = spWritePolicyFromEnv(env);
        return { ...current, profileIds: current.profileIds.filter((id) => id === identity.profileId), planIds: [identity.planId, inverseId] }; },
      prepareProviders: createSpWriteProviderPreparation(database, env),
      reconcileObservation: async (observation) => { await reconcileSpWriteObservation(database, observation); return true; },
    });
    const snapshots = [];
    let attemptedCalls = 0;
    for (const operation of [identity, inverseIdentity]) {
      await runtime.startExecution({ approvalId: operation.approvalId, planId: operation.planId });
      while (true) {
        const now = await readSpWriteDatabaseTime(database);
        if (Date.parse(now) >= Date.parse(authorization.expiresAt)) throw new Error('Live smoke observation window expired');
        // Re-read the file on every pass: removal, expiry or changed authority stops new attempts.
        if ((await readLiveWriteAuthorization(root, now)).fingerprint !== authorization.fingerprint) throw new Error('Live smoke authority changed');
        const tick = await loop.tick();
        attemptedCalls += tick.attemptedCalls;
        if (tick.kind === 'fault') throw new Error('Live smoke custody could not be confirmed');
        const evidence = await runtime.loadVerifiedExecution(operation);
        if (evidence === null) throw new Error('Live smoke evidence is missing');
        const a = evidence.snapshot.accounting;
        if (a.refusedBeforeDispatch + a.providerRejected + a.observationConflict + a.observationMissing > 0
          || a.observedExpectedAfterAmbiguous > 0) throw new Error('Live smoke refused or conflicted; inspect the recorded operation');
        if (a.observedRequested === a.approvedRows) {
          const [mirror] = await database.sql<{ count: number }[]>`select count(*)::int as count
            from public.sp_write_mirror_observations where org_id=${operation.orgId} and profile_id=${operation.profileId}
              and execution_id=${operation.executionId} and plan_id=${operation.planId} and outcome in ('promoted','already_current')`;
          if (mirror?.count !== a.approvedRows) throw new Error('Live smoke mirror observation count differs');
          snapshots.push(evidence.snapshot);
          break;
        }
        await delay(1_000);
      }
    }
    if (snapshots.length !== 2) throw new Error('Live smoke forward/inverse count differs');
    const [disabled] = await database.sql<{ count: number }[]>`select count(*)::int as count
      from public.sp_write_bounded_authorization_revocations where authorization_id=${authorization.authorizationId}`;
    if (disabled?.count !== 1) throw new Error('Live smoke authorization did not close after the inverse');
    return { attemptedCalls, forward: snapshots[0], inverse: snapshots[1] };
  } finally { loop?.stop(); await database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Read authority first, even when arguments or runtime credentials are absent.
  await readLiveWriteAuthorization(process.cwd());
  const [orgId, profileId, executionId, planId, approvalId, generation] = process.argv.slice(2).map((value) => Uuid.parse(value));
  if (!orgId || !profileId || !executionId || !planId || !approvalId || !generation || process.argv.length !== 8) {
    throw new Error('Expected org, profile, execution, forward plan, approval and generation IDs');
  }
  console.info(await runLiveWriteSmoke(process.cwd(), { orgId, profileId, executionId, planId, approvalId, generation }));
}
