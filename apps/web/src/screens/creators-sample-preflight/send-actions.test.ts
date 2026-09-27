/**
 * The send section's server actions refuse any body that is not exactly the
 * strict envelope: a plaintext field never reaches the ledger, a connection is
 * never opened for it, and nothing is logged.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { creatorMcfRecipientKeyId, sealCreatorMcfRecipient, type CreatorMcfRecipientBinding } from '@wizard-ads/shared';

const ledger = vi.hoisted(() => ({
  seal: vi.fn(), approve: vi.fn(), withdraw: vi.fn(), refresh: vi.fn(), settle: vi.fn(), release: vi.fn(), resolve: vi.fn(), open: vi.fn(), close: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('../../server/request-context', () => ({
  requestActor: async () => ({ orgId: '33400000-0000-4000-8000-0000000000a0', userId: '33400000-0000-4000-8000-0000000000b0' }),
}));
vi.mock('../../data/db', () => ({ requireDatabase: () => { ledger.open(); return { sql: {}, close: async () => { ledger.close(); } }; } }));
vi.mock('@wizard-ads/db', () => ({
  AgencyAccessDenied: class AgencyAccessDenied extends Error {},
  sealCreatorMcfRecipient: ledger.seal, approveCreatorMcfSend: ledger.approve, withdrawCreatorMcfSend: ledger.withdraw,
  refreshCreatorMcfPreview: ledger.refresh, requestCreatorMcfSettleRead: ledger.settle, releaseCreatorMcfSend: ledger.release,
  resolveCreatorMcfConflict: ledger.resolve,
}));

const { approveAction, releaseAction, resolveConflictAction, sealAction, withdrawAction } = await import('./send-actions');

const binding: CreatorMcfRecipientBinding = {
  orgId: '33400000-0000-4000-8000-0000000000a0', creatorRecordId: 'CCR-SW-26-0088', asin: 'B0D9K3M2QP',
  derivedOrderKey: 'CCS-5a0f3c9e1b7d42a8c6e0f1b3d5a7c9e1', reservationId: 'MCFR-00000000000000D8',
};
let envelope: Awaited<ReturnType<typeof sealCreatorMcfRecipient>>;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
  envelope = await sealCreatorMcfRecipient(jwk, await creatorMcfRecipientKeyId(jwk), binding, {
    name: 'Synthetic Person', addressLine1: '1 Example Way', city: 'Exampleton', stateOrRegion: 'CA', postalCode: '94000', countryCode: 'US',
  });
});

afterEach(() => { for (const fn of Object.values(ledger)) fn.mockReset(); });

describe('sealAction', () => {
  it('forwards exactly {binding, envelope} for the lane the binding names', async () => {
    ledger.seal.mockResolvedValue({ outcome: 'sealed', sendId: '33800000-0000-4000-8000-000000000501', state: 'sealed', replay: false,
      custodyExpiresAt: '2026-09-09T08:35:00.000Z' });
    const result = await sealAction({ binding, envelope });
    expect(result).toEqual({ ok: true, sendId: '33800000-0000-4000-8000-000000000501', state: 'sealed', custodyExpiresAt: '2026-09-09T08:35:00.000Z' });
    expect(ledger.seal).toHaveBeenCalledTimes(1);
    const [, actor, input] = ledger.seal.mock.calls[0]! as [unknown, { orgId: string }, { creatorRecordId: string; asin: string; request: unknown }];
    expect(actor.orgId).toBe(binding.orgId);
    expect(input.creatorRecordId).toBe(binding.creatorRecordId);
    expect(input.asin).toBe(binding.asin);
    expect(Object.keys(input.request as object).sort()).toEqual(['binding', 'envelope']);
    expect(ledger.open).toHaveBeenCalledTimes(1);
    // The process-owned handle is shared; an action never closes it.
    expect(ledger.close).not.toHaveBeenCalled();
  });

  it('refuses any body carrying a plaintext field, at any level, before opening a connection', async () => {
    const plaintext = { name: 'Synthetic Person', addressLine1: '1 Example Way', postalCode: '94000' };
    const bodies: unknown[] = [
      { binding, envelope, recipient: plaintext },
      { binding, envelope: { ...envelope, name: 'Synthetic Person' } },
      { binding, envelope: { ...envelope, mask: { ...envelope.mask, postalCode: '94000' } } },
      { binding: { ...binding, addressLine1: '1 Example Way' }, envelope },
      { ...plaintext, countryCode: 'US' },
      { binding, envelope, phone: '0000000000' },
      JSON.parse(`{"binding":${JSON.stringify(binding)},"envelope":${JSON.stringify(envelope)},"__proto__":{"name":"Synthetic Person"}}`),
      { binding, envelope: { ...envelope, ciphertext: undefined, plaintext: 'Synthetic Person' } },
      null, 'Synthetic Person, 1 Example Way', [binding, envelope],
    ];
    for (const body of bodies) expect(await sealAction(body)).toEqual({ ok: false, reason: 'envelope_invalid' });
    expect(ledger.seal).not.toHaveBeenCalled();
    expect(ledger.open).not.toHaveBeenCalled();
  });

  it('returns the ledger\'s refusal code and hides an unexpected failure\'s message', async () => {
    ledger.seal.mockResolvedValueOnce({ outcome: 'refused', reason: 'binding_mismatch' });
    expect(await sealAction({ binding, envelope })).toEqual({ ok: false, reason: 'binding_mismatch' });
    const log = vi.spyOn(console, 'error');
    ledger.seal.mockRejectedValueOnce(new Error('connection refused near "Synthetic Person"'));
    expect(await sealAction({ binding, envelope })).toEqual({ ok: false, reason: 'unavailable' });
    expect(log).not.toHaveBeenCalled();
    expect(ledger.close).not.toHaveBeenCalled();
  });
});

describe('the other actions', () => {
  const sendId = '33800000-0000-4000-8000-000000000501';

  it('accept only the strict approval with the exact wording', async () => {
    const approval = { sendId, previewId: '33800000-0000-4000-8000-0000000000a1', previewFingerprint: '9d'.repeat(32), totalUnits: 1,
      confirmation: 'Send 1 unit via Amazon', requestId: '33800000-0000-4000-8000-0000000000f1' };
    ledger.approve.mockResolvedValue({ outcome: 'approved', sendId, state: 'approved', replay: false, claimDeadline: '2026-09-09T06:54:00.000Z', units: 1 });
    expect(await approveAction(approval)).toEqual({ ok: true, sendId, state: 'approved', claimDeadline: '2026-09-09T06:54:00.000Z' });
    for (const bad of [{ ...approval, confirmation: 'Send 1 units via Amazon' }, { ...approval, confirmation: 'Yes, send' }, { ...approval, totalUnits: 2 },
      { ...approval, extra: true }]) {
      expect(await approveAction(bad)).toEqual({ ok: false, reason: 'approval_invalid' });
    }
    expect(ledger.approve).toHaveBeenCalledTimes(1);
  });

  it('accept only a uuid send id and request id', async () => {
    for (const bad of ['', 'not-a-uuid', 7, null, `${sendId} `]) {
      expect(await withdrawAction(bad)).toEqual({ ok: false, reason: 'invalid' });
      expect(await releaseAction(bad)).toEqual({ ok: false, reason: 'invalid' });
      expect(await resolveConflictAction(sendId, bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(ledger.open).not.toHaveBeenCalled();
    ledger.withdraw.mockResolvedValue({ outcome: 'withdrawn', sendId, state: 'withdrawn', replay: false });
    expect(await withdrawAction(sendId)).toEqual({ ok: true, sendId, state: 'withdrawn' });
  });
});
