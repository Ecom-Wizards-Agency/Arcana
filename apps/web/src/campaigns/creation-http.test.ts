import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CampaignCreationAdmissionError } from '@wizard-ads/db';
import { CampaignCreationRefusalCode } from '@wizard-ads/shared';

const boundary = vi.hoisted(() => ({ approve: vi.fn(), review: vi.fn(), read: vi.fn(), editor: vi.fn(), snapshot: vi.fn(), actor: vi.fn(), close: vi.fn() }));
vi.mock('@wizard-ads/db', async (original) => ({ ...await original<object>(),
  withAuthenticatedOrgEditor: boundary.editor, withAuthenticatedReadSnapshot: boundary.snapshot,
  readCampaignCreationBatch: boundary.read,
}));
vi.mock('./creation-approval', () => ({ approveSavedCampaignCreation: boundary.approve, reviewSavedCampaignCreationRetry: boundary.review }));
vi.mock('../server/request-context', async (original) => ({ ...await original<object>(),
  requestActor: boundary.actor, openWebDatabase: () => ({ close: boundary.close }),
}));
import { POST } from '../../app/api/campaigns/creation/route';
import { GET } from '../../app/api/campaigns/creation/status/route';
import { POST as REVIEW } from '../../app/api/campaigns/creation/review/route';

const profileId = '00000000-0000-4000-8000-000000000002';
const draftId = '00000000-0000-4000-8000-000000000003';
const batchId = '00000000-0000-4000-8000-000000000004';
const actor = { orgId: '00000000-0000-4000-8000-000000000005', userId: '00000000-0000-4000-8000-000000000006' };
const binding = { action: 'create', profileId, draftId, expectedRevision: 2, planFingerprint: 'a'.repeat(64) };
const request = (body: unknown) => new Request('http://localhost/api/campaigns/creation', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks(); boundary.actor.mockResolvedValue(actor);
  boundary.editor.mockImplementation(async (_database, current, run) => run({ actor: current }));
  boundary.snapshot.mockImplementation(async (_database, current, run) => run({ actor: current }));
});
describe('campaign creation HTTP boundary', () => {
  it('passes the exact displayed binding through the editor transaction and closes it once', async () => {
    boundary.approve.mockResolvedValue({ id: batchId });
    const response = await POST(request(binding));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ id: batchId });
    expect(boundary.approve).toHaveBeenCalledExactlyOnceWith({ actor }, binding);
    expect(boundary.editor).toHaveBeenCalledTimes(1); expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['draftId','expectedRevision','planFingerprint'])('refuses an omitted %s without admission', async (field) => {
    const body = { ...binding } as Record<string, unknown>; delete body[field];
    const response = await POST(request(body));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(boundary.approve).not.toHaveBeenCalled();
  });
  it.each(CampaignCreationRefusalCode.options)('preserves refusal code %s without retry', async (code) => {
    boundary.approve.mockRejectedValue(new CampaignCreationAdmissionError(code));
    const response = await POST(request(binding));
    expect(response.status).toBe(code === 'not_found' ? 404 : 409);
    expect(await response.json()).toMatchObject({ code }); expect(boundary.approve).toHaveBeenCalledTimes(1);
  });
  it('records retry review evidence for the exact approved draft and parent without admitting', async () => {
    const review = { profileId, draftId, expectedRevision: 2, planFingerprint: 'a'.repeat(64), parentBatchId: batchId };
    boundary.review.mockResolvedValue({ id: draftId, revision: 3 });
    const response = await REVIEW(new Request('http://localhost/api/campaigns/creation/review', { method: 'POST', body: JSON.stringify(review) }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ id: draftId, revision: 3 });
    expect(boundary.review).toHaveBeenCalledExactlyOnceWith({ actor }, review);
    expect(boundary.approve).not.toHaveBeenCalled(); expect(boundary.editor).toHaveBeenCalledTimes(1); expect(boundary.close).toHaveBeenCalledTimes(1);
    for (const field of ['draftId', 'expectedRevision', 'planFingerprint', 'parentBatchId']) {
      const body = { ...review } as Record<string, unknown>; delete body[field];
      const refused = await REVIEW(new Request('http://localhost/api/campaigns/creation/review', { method: 'POST', body: JSON.stringify(body) }));
      expect(refused.status).toBe(400); expect(await refused.json()).toMatchObject({ code: 'invalid_request' });
    }
    boundary.review.mockRejectedValue(new CampaignCreationAdmissionError('stale_revision'));
    const stale = await REVIEW(new Request('http://localhost/api/campaigns/creation/review', { method: 'POST', body: JSON.stringify(review) }));
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'stale_revision' });
    expect(boundary.review).toHaveBeenCalledTimes(2); expect(boundary.approve).not.toHaveBeenCalled();
  });
  it('returns 404 when the authenticated snapshot cannot see another organization’s batch', async () => {
    boundary.read.mockResolvedValue(null);
    const response = await GET(new Request(`http://localhost/api/campaigns/creation/status?profileId=${profileId}&batchId=${batchId}`));
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'not_found' });
    expect(boundary.read).toHaveBeenCalledExactlyOnceWith({ actor }, profileId, batchId);
    expect(boundary.snapshot).toHaveBeenCalledTimes(1); expect(boundary.approve).not.toHaveBeenCalled();
  });
});
