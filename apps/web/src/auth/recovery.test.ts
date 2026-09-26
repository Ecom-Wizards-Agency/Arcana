import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgActor } from '@wizard-ads/shared';

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
  generate: vi.fn(),
  issue: vi.fn(),
}));

vi.mock('@wizard-ads/db', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  issueMemberRecoveryLinkForActor: mocks.issue,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { admin: { generateLink: mocks.generate } } }),
}));

vi.mock('./config', () => ({
  authFeatureConfig: () => ({ passwordRecovery: true }),
}));
vi.mock('./origin', () => ({ authOrigin: () => 'https://app.example.test' }));
vi.mock('./supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: () => Promise.resolve({
    auth: { resetPasswordForEmail: mocks.reset },
  }),
}));

import { AgencyAccessDenied, MemberRecoveryLinkRefused } from '@wizard-ads/db';
import { createMemberRecoveryLink, requestPasswordRecovery } from './recovery';

describe('password recovery request', () => {
  beforeEach(() => mocks.reset.mockReset());

  it.each([
    ['accepted', { data: {}, error: null }],
    ['unknown account', { data: null, error: new Error('not found') }],
  ])('returns the same public result when the provider reports %s', async (_case, providerResult) => {
    mocks.reset.mockResolvedValue(providerResult);
    await expect(requestPasswordRecovery('member@example.test')).resolves.toEqual({ status: 'sent' });
    expect(mocks.reset).toHaveBeenCalledWith('member@example.test', {
      redirectTo: 'https://app.example.test/auth/recovery/callback?next=%2Fdashboard',
    });
  });

  it.each([
    ['/invite/synthetic-invitation', '%2Finvite%2Fsynthetic-invitation'],
    ['https://other.example.test', '%2Fdashboard'],
    ['//other.example.test', '%2Fdashboard'],
  ])('preserves only a safe continuation: %s', async (next, encoded) => {
    await requestPasswordRecovery('member@example.test', next);
    expect(mocks.reset).toHaveBeenCalledExactlyOnceWith('member@example.test', {
      redirectTo: `https://app.example.test/auth/recovery/callback?next=${encoded}`,
    });
  });
});

describe('owner/admin member reset link', () => {
  const actor: OrgActor = { orgId: '22222222-2222-4222-8222-222222222222', userId: '11111111-1111-4111-8111-111111111111' };
  const member = '33333333-3333-4333-8333-333333333333';
  const handle = {} as Parameters<typeof createMemberRecoveryLink>[0];
  const hashed = randomBytes(28).toString('hex');
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ['synthetic', 'service', 'key'].join('-'));
    mocks.issue.mockImplementation(async (_handle, _actor, _target, issue: (email: string) => Promise<string | null>) => {
      const url = await issue('member@example.test');
      if (!url) throw new Error('Recovery link unavailable');
      return { url, email: 'member@example.test' };
    });
    mocks.generate.mockResolvedValue({ error: null, data: { user: { email: 'member@example.test' }, properties: { hashed_token: hashed } } });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns a callback link with the one-time token hash and sends no email', async () => {
    const result = await createMemberRecoveryLink(handle, actor, member);
    expect(result).toEqual({
      status: 'ok', email: 'member@example.test',
      url: `https://app.example.test/auth/recovery/callback?next=%2Fdashboard&token_hash=${hashed}`,
    });
    expect(mocks.issue).toHaveBeenCalledExactlyOnceWith(handle, actor, { userId: member }, expect.any(Function));
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith({
      type: 'recovery', email: 'member@example.test',
      options: { redirectTo: 'https://app.example.test/auth/recovery/callback?next=%2Fdashboard' },
    });
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('maps every refusal to fixed copy without calling Auth', async () => {
    const messages: string[] = [];
    for (const refusal of [
      new MemberRecoveryLinkRefused('rate_limited'), new MemberRecoveryLinkRefused('owner_only'),
      new MemberRecoveryLinkRefused('self'), new MemberRecoveryLinkRefused('not_member'),
      new MemberRecoveryLinkRefused('other_orgs'), new AgencyAccessDenied(),
    ]) {
      mocks.issue.mockRejectedValueOnce(refusal);
      const result = await createMemberRecoveryLink(handle, actor, member);
      if (result.status !== 'error') throw new Error('Expected a refusal');
      messages.push(result.message);
    }
    expect(messages).toEqual([
      'A reset link was created for this member in the last 10 minutes. Try again later.',
      'Only an owner can create a reset link for another owner.',
      'Change your own password from your account settings.',
      'That person is no longer a member.',
      'This member also belongs to a workspace you do not manage, so they must reset their password themselves.',
      'Only admins and owners can manage members.',
    ]);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('fails closed without Auth administration or a verified provider response', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(await createMemberRecoveryLink(handle, actor, member)).toEqual({ status: 'error', message: 'Reset links are not configured for this installation.' });
    expect(mocks.issue).not.toHaveBeenCalled();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ['synthetic', 'service', 'key'].join('-'));
    mocks.generate.mockImplementationOnce(async () => { throw new Error(`synthetic loss ${hashed}`); });
    const failed = await createMemberRecoveryLink(handle, actor, member);
    expect(failed).toEqual({ status: 'error', message: 'The reset link could not be created. Try again later.' });
    expect(JSON.stringify(failed)).not.toContain(hashed);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});
