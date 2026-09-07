import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Forbidden } from '../../../src/auth/roles';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(), gateAction: vi.fn(), connect: vi.fn(), revoke: vi.fn(),
  createLink: vi.fn(), removeLink: vi.fn(), editor: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../../src/auth/guard', () => ({ gateAction: mocks.gateAction }));
vi.mock('@wizard-ads/db', () => ({
  INTEGRATION_PROVIDERS: ['keepa', 'datadive', 'mrp'],
  connectIntegrationCredentialForActor: mocks.connect,
  revokeIntegrationCredentialForActor: mocks.revoke,
  createCompetitorLink: mocks.createLink,
  removeCompetitorLink: mocks.removeLink,
  withAuthenticatedOrgEditor: mocks.editor,
}));
import { addCompetitorLink, connectIntegration, deleteCompetitorLink, revokeIntegration } from './actions';

const handle = {};
const actor = { orgId: '11111111-1111-4111-8111-111111111111', userId: '44444444-4444-4444-8444-444444444444' };
const connectionId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const context = { sql: {}, actor };
const testValue = ['synthetic', 'value'].join('-');
const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe('integration settings actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId: actor.orgId, role: 'admin' }, userId: actor.userId });
    mocks.editor.mockImplementation(async (_handle, _actor, operation) => operation(context));
  });

  it.each(['analyst', 'viewer'] as const)('refuses a %s credential change before admission', async (role) => {
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId: actor.orgId, role }, userId: actor.userId });
    await expect(connectIntegration(form({ provider: 'keepa', secret: testValue }))).rejects.toBeInstanceOf(Forbidden);
    await expect(revokeIntegration(form({ connectionId }))).rejects.toBeInstanceOf(Forbidden);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('uses only the verified actor and normalized form details for the complete credential operation', async () => {
    await connectIntegration(form({ provider: 'datadive', label: ' Primary ', secret: testValue,
      orgId: connectionId, userId: connectionId, connectedBy: connectionId, config: '{"forged":true}' }));
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(handle, actor, { provider: 'datadive', label: 'Primary' }, testValue);
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith('/settings/integrations');
  });

  it('does not revalidate or retry when the complete credential operation cannot confirm its outcome', async () => {
    mocks.connect.mockRejectedValue(new Error('Synthetic unconfirmed outcome'));
    await expect(connectIntegration(form({ provider: 'keepa', secret: testValue }))).rejects.toThrow('Synthetic unconfirmed outcome');
    expect(mocks.connect).toHaveBeenCalledTimes(1); expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('passes a revoke to current authority and propagates a foreign-resource refusal without retry', async () => {
    mocks.revoke.mockRejectedValue(new Error('Integration connection not found'));
    await expect(revokeIntegration(form({ connectionId, orgId: connectionId }))).rejects.toThrow('not found');
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(handle, actor, connectionId);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('runs competitor writes through the authenticated editor transaction', async () => {
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId: actor.orgId, role: 'analyst' }, userId: actor.userId });
    await addCompetitorLink(form({ profileId, ourAsin: 'b0test0001', competitorAsin: 'b0test0002', orgId: connectionId }));
    expect(mocks.createLink).toHaveBeenCalledExactlyOnceWith(context, {
      orgId: actor.orgId, profileId, ourAsin: 'B0TEST0001', competitorAsin: 'B0TEST0002',
    });
    await deleteCompetitorLink(form({ linkId: connectionId }));
    expect(mocks.removeLink).toHaveBeenCalledExactlyOnceWith(context, { orgId: actor.orgId, id: connectionId });
    expect(mocks.editor).toHaveBeenCalledTimes(2);
    expect(mocks.editor.mock.calls.every((call) => call[0] === handle && call[1].orgId === actor.orgId && call[1].userId === actor.userId)).toBe(true);
  });

  it('refuses viewer competitor writes and malformed resource identifiers before opening a transaction', async () => {
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId: actor.orgId, role: 'viewer' }, userId: actor.userId });
    await expect(addCompetitorLink(form({ profileId, ourAsin: 'B0TEST0001', competitorAsin: 'B0TEST0002' }))).rejects.toBeInstanceOf(Forbidden);
    await expect(deleteCompetitorLink(form({ linkId: connectionId }))).rejects.toBeInstanceOf(Forbidden);
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId: actor.orgId, role: 'admin' }, userId: actor.userId });
    await expect(revokeIntegration(form({ connectionId: 'malformed' }))).rejects.toThrow('Invalid integration resource');
    await expect(deleteCompetitorLink(form({ linkId: 'malformed' }))).rejects.toThrow('Invalid integration resource');
    expect(mocks.editor).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
