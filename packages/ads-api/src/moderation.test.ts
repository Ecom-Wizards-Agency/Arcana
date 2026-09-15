import { describe, expect, it, vi } from 'vitest';
import { ModerationClient, parsePreModerationEvidence, PRE_MODERATION_COLLECTION, sanitizeModerationReason } from './moderation.js';
const scope = { region: 'EU', amazonProfileId: '1000000001' } as const;
const context = { scope, marketplace: 'DE', program: 'SB_VIDEO' };
const observedAt = '2026-09-15T10:00:00.000Z';
function harness(rows: unknown[]) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(rows.shift()), { status: 200 }));
  const client = new ModerationClient({ scope, fetch, headers: async () => ({ 'Amazon-Advertising-API-Scope': scope.amazonProfileId }), now: () => Date.parse(observedAt) });
  return { client, fetch };
}
const result = (moderationStatus: string) => ({ moderationResults: [{ id: 'ad-one', idType: 'AD_ID', versionId: 'creative-v2', moderationStatus,
  policyViolations: moderationStatus === 'REJECTED' ? [{ policyDescription: 'The image contains prohibited content.' }] : [] }] });
const input = { context, adId: 'ad-one', adVersion: 'creative-v2' };

describe('scoped moderation evidence', () => {
  it('records pending → approved → rejected without assigning an ad version to an asset', async () => {
    const { client, fetch } = harness(['IN_PROGRESS', 'APPROVED', 'REJECTED'].map(result));
    const observations = [];
    for (let i=0;i<3;i++) { const read = await client.readAd(input); expect(read.counts).toEqual({ pages: 1, received: 1, parsed: 1, refused: 0, returned: 1 }); observations.push(read.observations[0]); }
    expect(observations.map((row) => row?.status)).toEqual(['pending', 'approved', 'rejected']);
    expect(observations.every((row) => row?.assetIdentity === null)).toBe(true);
    expect(observations[2]?.reasons).toEqual(['The image contains prohibited content.']);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    const headers = new Headers(calls[0]?.[1].headers);
    expect(headers.get('Accept')).toBe('application/vnd.moderationresultsresponse.v4.0+json');
    expect(headers.get('Content-Type')).toBe('application/vnd.moderationresultsrequest.v4.1+json');
  });
  it.each(['FAILED', 'NEW_SCHEMA_STATE'])('maps %s to unknown', async (state) => {
    const { client } = harness([result(state)]); expect((await client.readAd(input)).observations[0]?.status).toBe('unknown');
  });
  it('fails closed for another ad version, profile or program', async () => {
    const { client, fetch } = harness([result('APPROVED')]);
    await expect(client.readAd({ ...input, context: { ...context, scope: { ...scope, amazonProfileId: '1000000002' } } })).rejects.toThrow('scope mismatch');
    await expect(client.readAd({ ...input, context: { ...context, program: 'DSP' } })).rejects.toThrow('Unsupported');
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.readAd({ ...input, adVersion: 'creative-v3' })).rejects.toThrow('identity mismatch');
  });
  it('reads SD pending status without guessing its absent creative version', async () => {
    const { client } = harness([[{ creativeId: 12, moderationStatus: 'PENDING_REVIEW', policyViolations: [] }]]);
    const read = await client.readSd({ context: { ...context, program: 'SPONSORED_DISPLAY' }, creativeIds: ['12'], language: 'de-DE' });
    expect(read.observations[0]).toMatchObject({ status: 'pending', subject: { kind: 'creative', creativeId: '12', creativeVersion: null }, assetIdentity: null });
  });
  it('rejects SD numeric identifiers that cannot survive JSON exactly', async () => {
    const { client } = harness([[{ creativeId: Number.MAX_SAFE_INTEGER+1, moderationStatus: 'APPROVED' }]]);
    await expect(client.readSd({ context: { ...context, program: 'SPONSORED_DISPLAY' }, creativeIds: ['synthetic'], language: 'de-DE' })).rejects.toThrow('unsafe');
  });
  it('preserves safe reason wording and strips links, identifiers and credentials', () => {
    expect(sanitizeModerationReason('The image contains prohibited content.')).toBe('The image contains prohibited content.');
    const text = sanitizeModerationReason('Asset synthetic-private-ad violates policy https://example.invalid/private token=private-value user@example.invalid', ['synthetic-private-ad']);
    expect(text).not.toContain('synthetic-private-ad'); expect(text).not.toContain('private-value'); expect(text).not.toContain('example.invalid');
    expect(text).toContain('violates policy');
  });
  it('retains pre-moderation stage and refuses context/row mismatch without any submission surface', () => {
    const preContext = { ...context, program: 'SPONSORED_BRANDS_VIDEO' };
    const request = { context: preContext, locale: 'de-DE', components: [{ kind: 'video' as const, id: 'component-one', componentType: 'SPONSORED_BRANDS_VIDEO' }], observedAt };
    const raw = { adProgram: preContext.program, locale: 'de-DE', preModerationId: 'pre-one', videoComponents: [{ id: 'component-one', componentType: 'SPONSORED_BRANDS_VIDEO', preModerationStatus: 'APPROVED', url: 'https://example.invalid/transient' }] };
    const parsed = parsePreModerationEvidence(raw, request);
    expect(parsed.observations[0]).toMatchObject({ stage: 'pre_moderation', status: 'approved', assetIdentity: null });
    expect(JSON.stringify(parsed)).not.toContain('transient');
    expect(PRE_MODERATION_COLLECTION.supported).toBe(false);
    expect(() => parsePreModerationEvidence({ ...raw, locale: 'en-US' }, request)).toThrow('context mismatch');
    expect(() => parsePreModerationEvidence({ ...raw, videoComponents: [] }, request)).toThrow('count mismatch');
  });
});
