import { beforeEach, describe, expect, it, vi } from 'vitest';

const FACTOR_ID = '11111111-1111-4111-8111-111111111111';
const STALE_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  listFactors: vi.fn(),
  unenroll: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
  config: vi.fn(),
}));

vi.mock('./config', () => ({
  authFeatureConfig: mocks.config,
}));
vi.mock('./security-authorization', () => ({
  authorizeSecurityChange: mocks.authorize,
}));
vi.mock('./supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: () => Promise.resolve({
    auth: {
      mfa: {
        listFactors: mocks.listFactors,
        unenroll: mocks.unenroll,
        enroll: mocks.enroll,
        challengeAndVerify: mocks.challengeAndVerify,
      },
      refreshSession: mocks.refreshSession,
      signOut: mocks.signOut,
    },
  }),
}));

import { beginTotpEnrollment, removeTotpFactor, removeTotpFactors, verifyTotpChallenge } from './totp';

function listed(ids: readonly string[]) {
  const factors = ids.map((id) => ({ id, factor_type: 'totp', status: 'verified' }));
  return { data: { all: factors, totp: factors }, error: null };
}

describe('TOTP operations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.config.mockReturnValue({ totpPolicy: 'enrollment-only' });
    mocks.authorize.mockResolvedValue({
      status: 'ok',
      user: { id: 'user-1', email: 'member@example.test' },
    });
    mocks.unenroll.mockResolvedValue({ data: {}, error: null });
    mocks.challengeAndVerify.mockResolvedValue({ data: {}, error: null });
    mocks.refreshSession.mockResolvedValue({ data: { session: {} }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it('cleans up every stale enrollment before creating exactly one replacement', async () => {
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [
          { id: STALE_ID, factor_type: 'totp', status: 'unverified' },
          { id: FACTOR_ID, factor_type: 'totp', status: 'verified' },
        ],
        totp: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
      },
      error: null,
    });
    mocks.enroll.mockResolvedValue({
      data: {
        id: STALE_ID,
        type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;utf-8,%3Csvg%20/%3E', secret: 'MANUAL' },
      },
      error: null,
    });

    await expect(beginTotpEnrollment()).resolves.toEqual({
      status: 'enrolling',
      factorId: STALE_ID,
      qrCode: 'data:image/svg+xml;utf-8,%3Csvg%20/%3E',
      manualSecret: 'MANUAL',
    });
    expect(mocks.unenroll).toHaveBeenCalledTimes(1);
    expect(mocks.unenroll).toHaveBeenCalledWith({ factorId: STALE_ID });
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
  });

  it('verifies only a listed, already-verified TOTP challenge factor', async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [], totp: [] },
      error: null,
    });
    await expect(verifyTotpChallenge({ factorId: FACTOR_ID, code: '123456' })).resolves.toEqual({
      status: 'error',
      message: 'That authenticator is no longer available.',
    });
    expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
  });

  it('requires server-side step-up before removing an authenticator', async () => {
    mocks.authorize.mockResolvedValue({ status: 'challenge', href: '/auth/mfa/challenge' });
    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'challenge',
      message: 'Verify an existing authenticator before changing account security.',
      href: '/auth/mfa/challenge',
    });
    expect(mocks.listFactors).not.toHaveBeenCalled();
    expect(mocks.unenroll).not.toHaveBeenCalled();
  });

  it('reports a removed factor but refuses to continue on a stale session', async () => {
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
        totp: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
      },
      error: null,
    });
    mocks.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    });

    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'error',
      message: 'Authenticator settings may have changed. Sign in again to verify them.',
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('also clears the local session when the refresh provider returns an error', async () => {
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
        totp: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
      },
      error: null,
    });
    mocks.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new Error('refresh failed'),
    });

    await expect(removeTotpFactor(FACTOR_ID)).resolves.toMatchObject({ status: 'error' });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('allows verified removal while enrollment is off and observes the factor absent', async () => {
    mocks.config.mockReturnValue({ totpPolicy: 'off' });
    mocks.listFactors.mockResolvedValueOnce(listed([FACTOR_ID])).mockResolvedValueOnce(listed([]));
    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'ok', message: 'Authenticator 2FA is off.',
    });
    expect(mocks.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: FACTOR_ID });
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(mocks.listFactors).toHaveBeenCalledTimes(2);
    await expect(beginTotpEnrollment()).resolves.toMatchObject({ status: 'error' });
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it('checks ownership of the entire selection before removing any factor', async () => {
    mocks.listFactors.mockResolvedValue(listed([FACTOR_ID]));
    await expect(removeTotpFactors([FACTOR_ID, STALE_ID])).resolves.toMatchObject({ status: 'error' });
    expect(mocks.unenroll).not.toHaveBeenCalled();
  });

  it('does not modify another owned factor when removing only the selected factor', async () => {
    mocks.listFactors.mockResolvedValueOnce(listed([FACTOR_ID, STALE_ID])).mockResolvedValueOnce(listed([STALE_ID]));
    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'ok', message: 'Removed 1 authenticator. 1 remain; authenticator 2FA is still on.',
    });
    expect(mocks.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: FACTOR_ID });
  });

  it('reports partial removal and never claims 2FA is off while a selected factor remains', async () => {
    mocks.listFactors.mockResolvedValueOnce(listed([FACTOR_ID, STALE_ID])).mockResolvedValueOnce(listed([STALE_ID]));
    mocks.unenroll.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: new Error('refused') });
    await expect(removeTotpFactors([FACTOR_ID, STALE_ID])).resolves.toEqual({
      status: 'error', message: 'Removed 1 of 2 selected authenticators. 1 remain; authenticator 2FA is still on.',
    });
    expect(mocks.unenroll).toHaveBeenCalledTimes(2);
  });

  it('observes an uncertain removal instead of retrying or advancing the selection', async () => {
    mocks.listFactors.mockResolvedValueOnce(listed([FACTOR_ID, STALE_ID])).mockResolvedValueOnce(listed([STALE_ID]));
    mocks.unenroll.mockRejectedValueOnce(new Error('response lost'));
    await expect(removeTotpFactors([FACTOR_ID, STALE_ID])).resolves.toMatchObject({
      status: 'error', message: 'Removed 1 of 2 selected authenticators. 1 remain; authenticator 2FA is still on.',
    });
    expect(mocks.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: FACTOR_ID });
  });

  it('refuses to equate a successful provider response with observed removal', async () => {
    mocks.listFactors.mockResolvedValue(listed([FACTOR_ID]));
    await expect(removeTotpFactor(FACTOR_ID)).resolves.toMatchObject({
      status: 'error', message: 'Removed 0 of 1 selected authenticators. 1 remain; authenticator 2FA is still on.',
    });
  });

  it('reports uncertainty when post-removal inventory cannot be read', async () => {
    mocks.listFactors.mockResolvedValueOnce(listed([FACTOR_ID])).mockRejectedValueOnce(new Error('offline'));
    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'error', message: 'Authenticator removal could not be verified. Reload Account settings before trying again.',
    });
  });

  it.each([{ ids: [] }, { ids: [FACTOR_ID, FACTOR_ID] }, { ids: ['not-an-id'] }])('rejects an invalid selection before provider access: $ids', async ({ ids }) => {
    await expect(removeTotpFactors(ids)).resolves.toMatchObject({ status: 'error' });
    expect(mocks.listFactors).not.toHaveBeenCalled();
    expect(mocks.unenroll).not.toHaveBeenCalled();
  });
});
