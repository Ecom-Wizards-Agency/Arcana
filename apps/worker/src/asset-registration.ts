import { createHash } from 'node:crypto';
import { AssetRegistrationIntent, type AssetLibraryRegistrationOutcome, EvidenceReconciliationCounts,
  type AssetLibraryIdentity } from '@wizard-ads/shared';
import { reserveAssetRegistration, settleAssetRegistration, type DbHandle } from '@wizard-ads/db';
import { validateAssetLibraryUpload, type AssetLibraryClient } from '@wizard-ads/ads-api';

/** No caller can convert campaign authority into asset authority. Provider effects are injected. */
export async function executeAssetRegistration(input: {
  handle: Pick<DbHandle, 'sql'>; request: AssetRegistrationIntent; bytes: Uint8Array;
  enabled?: boolean; provider: Pick<AssetLibraryClient, 'scope' | 'upload' | 'register'>;
}) {
  const request = AssetRegistrationIntent.parse(input.request);
  if (!input.enabled) return { requested: 1, attempted: 0, succeeded: 0, failed: 0, refused: 1, reason: 'disabled' };
  if (input.provider.scope.region!==request.scope.region || input.provider.scope.amazonProfileId!==request.scope.amazonProfileId) return {requested:1,attempted:0,succeeded:0,failed:0,refused:1,reason:'scope_mismatch'};
  if (!validateAssetLibraryUpload(request.manifest,input.bytes) || (request.registration.assetType==='VIDEO') !== (request.manifest.contentType==='video/mp4'))
    return { requested: 1, attempted: 0, succeeded: 0, failed: 0, refused: 1, reason: 'invalid_media' };
  const reservation = await reserveAssetRegistration(input.handle, request.id, input.enabled);
  if (reservation.request === null) return { requested: 1, attempted: 0, succeeded: 0, failed: 0, refused: 1, reason: reservation.refusal };
  // Compare the admitted immutable request before using caller-supplied bytes or metadata.
  if (JSON.stringify(reservation.request) !== JSON.stringify(request)) {
    await settleAssetRegistration(input.handle, request.id, { kind: 'not_attempted', scope: reservation.request.scope, reason: 'invalid_input' });
    return { requested: 1, attempted: 0, succeeded: 0, failed: 0, refused: 1, reason: 'manifest_mismatch' };
  }
  let outcome: AssetLibraryRegistrationOutcome;
  try {
    const upload = await input.provider.upload(request.manifest, input.bytes);
    outcome = upload.kind === 'uploaded' ? await input.provider.register(upload.content, request.registration)
      : upload.kind === 'not_attempted' ? { kind: 'not_attempted', scope: request.scope, reason: 'invalid_input' }
        : { kind: 'uncertain', scope: request.scope, reason: 'transport_failed' };
  } catch { outcome = { kind: 'uncertain', scope: request.scope, reason: 'transport_failed' }; }
  await settleAssetRegistration(input.handle, request.id, outcome);
  return { ...EvidenceReconciliationCounts.parse({ requested: 1, attempted: 1,
    succeeded: outcome.kind === 'accepted' ? 1 : 0, failed: outcome.kind === 'uncertain' ? 1 : 0, refused: outcome.kind === 'refused' || outcome.kind === 'not_attempted' ? 1 : 0 }), outcome };
}

/** A resolver must independently establish the exact request checksum and provider identity.
 * Production has no resolver installed; absence or ambiguity stays uncertain. No upload retry. */
export async function reconcileUncertainAssetRegistrations(input: {
  handle: Pick<DbHandle, 'sql'>; enabled?: boolean; limit?: number;
  resolve: (request: AssetRegistrationIntent) => Promise<{ intentId: string; requestFingerprint: string; scope: AssetRegistrationIntent['scope']; identity: AssetLibraryIdentity } | null>;
}) {
  const counts = { requested: 0, attempted: 0, succeeded: 0, failed: 0, refused: 0 };
  if (!input.enabled) return EvidenceReconciliationCounts.parse(counts);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit<1 || limit>1000) throw new Error('Invalid asset resolution bound');
  const rows = await input.handle.sql<{ request: unknown }[]>`select request from public.asset_registration_intents
    where status='uncertain' order by created_at limit ${limit}`;
  for (const row of rows) {
    counts.requested++; counts.attempted++;
    try {
      const request = AssetRegistrationIntent.parse(row.request);
      const match = await input.resolve(request);
      if (!match || match.intentId!==request.id || match.requestFingerprint!==assetRegistrationFingerprint(request) || match.scope.region!==request.scope.region || match.scope.amazonProfileId!==request.scope.amazonProfileId) { counts.failed++; continue; }
      await settleAssetRegistration(input.handle, request.id, { kind: 'accepted', scope: request.scope, identity: match.identity, failedSpecChecks: null });
      counts.succeeded++;
    } catch { counts.failed++; }
  }
  return EvidenceReconciliationCounts.parse(counts);
}

export function assetRegistrationFingerprint(request: AssetRegistrationIntent): string {
  return createHash('sha256').update(JSON.stringify(AssetRegistrationIntent.parse(request))).digest('hex');
}
