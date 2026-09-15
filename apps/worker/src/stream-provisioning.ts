/** No production composition or job admission is supplied by this module. */
import { createHash } from 'node:crypto';
import { validateStreamConfirmation, type StreamSubscriptionsClient } from '@wizard-ads/ads-api';
import {
  StreamInfrastructureAuthority, StreamProvisioningIntent, StreamProvisioningReceipt,
  StreamSubscriptionCreated, StreamSubscriptionInventory, StreamSubscriptionObservation,
  type StreamConfirmationChallenge, type StreamSubscriptionScope,
} from '@wizard-ads/shared';

type Provider = Pick<StreamSubscriptionsClient, 'list' | 'get' | 'create' | 'archive' | 'confirm'>;
export interface StreamProvisioningStore {
  /** Atomically admit one immutable intent against current infrastructure authority.
   * Implementations must recheck revocation, expiry and scope inside the transaction.
   * An existing reservation, including one left by a crash, never grants a second attempt.
   */
  reserve(intent: StreamProvisioningIntent, authority: StreamInfrastructureAuthority, fingerprint: string,
    now: string): Promise<{ created: boolean; receipt: StreamProvisioningReceipt }>;
  /** Compare immutable identity and independently read back the persisted receipt. */
  finish(receipt: StreamProvisioningReceipt): Promise<StreamProvisioningReceipt>;
}

export function streamProvisioningFingerprint(rawIntent: StreamProvisioningIntent): string {
  return createHash('sha256').update(JSON.stringify(StreamProvisioningIntent.parse(rawIntent))).digest('hex');
}

function sameScope(left: StreamSubscriptionScope, right: StreamSubscriptionScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function assertObservation(scope: StreamSubscriptionScope, observation: StreamSubscriptionObservation): void {
  if (observation.datasetId !== scope.datasetId || observation.destinationArn !== scope.destinationArn)
    throw new Error('Stream subscription observation conflicts with approved scope');
}
function assertAuthority(intent: StreamProvisioningIntent, authority: StreamInfrastructureAuthority, now: Date): void {
  if (!Number.isFinite(now.getTime()) || !authority.enabled || Date.parse(authority.expiresAt) <= now.getTime()
    || Date.parse(intent.createdAt) > now.getTime() || !sameScope(intent.scope, authority.scope)
    || intent.action !== authority.action || streamProvisioningFingerprint(intent) !== authority.intentFingerprint)
    throw new Error('Stream infrastructure authority is missing, disabled, expired or mismatched');
}

/** One deliberately enabled, separately authorized infrastructure operation, fake-wired by tests only. */
export async function executeStreamProvisioning(input: {
  enabled?: boolean; intent: StreamProvisioningIntent; authority?: StreamInfrastructureAuthority;
  challenge?: StreamConfirmationChallenge; store: StreamProvisioningStore; provider: Provider; now?: () => Date;
}): Promise<StreamProvisioningReceipt> {
  if (input.enabled !== true || input.authority === undefined) throw new Error('Stream infrastructure provisioning is disabled');
  const intent = StreamProvisioningIntent.parse(input.intent);
  const authority = StreamInfrastructureAuthority.parse(input.authority);
  const now = input.now ?? (() => new Date());
  assertAuthority(intent, authority, now());
  const challenge = intent.action === 'confirm'
    ? validateStreamConfirmation(intent, input.challenge!) : undefined;
  const fingerprint = streamProvisioningFingerprint(intent);
  const reserved = await input.store.reserve(intent, authority, fingerprint, now().toISOString());
  const receipt = StreamProvisioningReceipt.parse(reserved.receipt);
  if (receipt.intentId !== intent.intentId || receipt.intentFingerprint !== fingerprint
    || receipt.authorityId !== authority.authorityId || (reserved.created && receipt.state !== 'reserved')
    || (intent.action !== 'create' && receipt.subscriptionId !== null && receipt.subscriptionId !== intent.subscriptionId))
    throw new Error('Stream infrastructure reservation identity mismatch');

  const finish = async (patch: Partial<StreamProvisioningReceipt>): Promise<StreamProvisioningReceipt> => {
    const next = StreamProvisioningReceipt.parse({ ...receipt, ...patch });
    const persisted = StreamProvisioningReceipt.parse(await input.store.finish(next));
    if (JSON.stringify(persisted) !== JSON.stringify(next)) throw new Error('Stream infrastructure receipt readback mismatch');
    return persisted;
  };
  if (!reserved.created) {
    if (receipt.state === 'observed' || receipt.state === 'conflict') return receipt;
    return reconcileStreamProvisioning(input.provider, intent, receipt, now, finish);
  }

  let subscriptionId = intent.action === 'create' ? null : intent.subscriptionId;
  try {
    if (intent.action !== 'create') {
      const observation = StreamSubscriptionObservation.parse(await input.provider.get(intent.scope, intent.subscriptionId));
      assertObservation(intent.scope, observation);
      if (observation.subscriptionId !== intent.subscriptionId) throw new Error('Subscription identity mismatch');
      if (intent.action === 'confirm' && observation.status !== 'PENDING_CONFIRMATION')
        return finish({ state: 'conflict', subscriptionId });
      if (intent.action === 'archive' && observation.status === 'ARCHIVED')
        return finish({ state: 'observed', subscriptionId, observedAt: now().toISOString() });
    }
    assertAuthority(intent, authority, now());
    if (intent.action === 'create') {
      const created = StreamSubscriptionCreated.parse(await input.provider.create(intent));
      if (created.clientRequestToken !== intent.clientRequestToken) throw new Error('Create token mismatch');
      subscriptionId = created.subscriptionId;
    } else if (intent.action === 'archive') await input.provider.archive(intent);
    else await input.provider.confirm(intent, challenge!);
  } catch {
    return finish({ state: 'uncertain', subscriptionId });
  }
  return finish({ state: 'accepted', subscriptionId });
}

async function reconcileStreamProvisioning(
  provider: Provider, intent: StreamProvisioningIntent, receipt: StreamProvisioningReceipt,
  now: () => Date, finish: (patch: Partial<StreamProvisioningReceipt>) => Promise<StreamProvisioningReceipt>,
): Promise<StreamProvisioningReceipt> {
  try {
    const subscriptionId = receipt.subscriptionId ?? (intent.action === 'create' ? null : intent.subscriptionId);
    if (subscriptionId === null) {
      const inventory = StreamSubscriptionInventory.parse(await provider.list(intent.scope));
      const matches = inventory.subscriptions.filter((row) => row.datasetId === intent.scope.datasetId
        && row.destinationArn === intent.scope.destinationArn);
      // The list contract has no clientRequestToken. Even one match cannot prove ownership of a lost create.
      return finish({ state: inventory.complete && matches.length > 1 ? 'conflict' : 'uncertain' });
    }
    const observation = StreamSubscriptionObservation.parse(await provider.get(intent.scope, subscriptionId));
    if (observation.subscriptionId !== subscriptionId || observation.datasetId !== intent.scope.datasetId
      || observation.destinationArn !== intent.scope.destinationArn) return finish({ state: 'conflict', subscriptionId });
    const observed = intent.action === 'create'
      || (intent.action === 'archive' && observation.status === 'ARCHIVED')
      || (intent.action === 'confirm' && observation.status === 'ACTIVE');
    return finish({ state: observed ? 'observed' : 'uncertain', subscriptionId,
      observedAt: observed ? now().toISOString() : receipt.observedAt });
  } catch { return finish({ state: 'uncertain' }); }
}
