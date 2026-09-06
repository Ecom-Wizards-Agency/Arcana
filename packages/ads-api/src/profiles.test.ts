/**
 * Profile discovery.
 *
 * The interesting case is not the happy path, it is the three-region walk: a
 * grant almost never covers all three hosts, so a 401 from two of them is the
 * normal result and must not lose the profiles the third returned.
 */
import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import { listProfilesAcrossRegions, listProfilesCounted, parseProfiles, parseProfilesCounted } from './profiles.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';
import { PROFILES_EU, PROFILES_NA } from './__fixtures__/payloads.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};

describe('parseProfiles', () => {
  it('maps the fields the profile roster stores', () => {
    const profiles = parseProfiles(PROFILES_NA, 'NA');
    const first = profiles[0];

    expect(first?.profileId).toBe('1111111111');
    expect(first?.region).toBe('NA');
    expect(first?.countryCode).toBe('US');
    expect(first?.currencyCode).toBe('USD');
    expect(first?.timezone).toBe('America/Los_Angeles');
    expect(first?.accountType).toBe('seller');
    expect(first?.accountName).toBe('Placeholder Seller One');
    expect(first?.amazonAccountId).toBe('SELLERID1');
    expect(first?.marketplaceStringId).toBe('MARKETPLACE1');
  });

  it('keeps a numeric profile id exact by reading it as a string', () => {
    const profiles = parseProfiles(PROFILES_NA, 'NA');
    expect(profiles.map((profile) => profile.profileId)).toEqual(['1111111111', '2222222222']);
  });

  it('drops only the entries with no profile id, and nothing else', () => {
    // Three recorded entries, one of them unusable.
    expect(PROFILES_NA).toHaveLength(3);
    expect(parseProfiles(PROFILES_NA, 'NA')).toHaveLength(2);
  });

  it('refuses a body that is not an array rather than returning nothing', () => {
    expect(() => parseProfiles({ profiles: [] }, 'NA')).toThrow(/JSON array/);
  });

  it('counts every malformed and rounded identifier without exposing raw input', () => {
    const result = parseProfilesCounted([null, {}, { profileId: Number.MAX_SAFE_INTEGER + 1 },
      { profileId: '9007199254740993' }], 'EU');
    expect(result.received).toBe(4);
    expect(result.profiles.map((p) => p.profileId)).toEqual(['9007199254740993']);
    expect(result.rejected).toEqual([
      { index: 0, reason: 'invalid_row' }, { index: 1, reason: 'invalid_profile_id' },
      { index: 2, reason: 'unsafe_profile_id' },
    ]);
  });

  it('refuses every copy of a duplicate instead of choosing an arbitrary account row', () => {
    const result = parseProfilesCounted([{ profileId: 1 }, { profileId: '1' },
      { profileId: '2' }, { profileId: 1 }], 'NA');
    expect(result.received).toBe(4);
    expect(result.profiles.map((p) => p.profileId)).toEqual(['2']);
    expect(result.rejected).toEqual([0, 1, 3].map((index) => ({ index, reason: 'duplicate_profile_id' })));
  });

  it('keeps parser counts through the actual discovery HTTP boundary', async () => {
    const server = createMockServer([lwaRoute(),
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 200, json: PROFILES_NA }] },
    ]);
    const result = await listProfilesCounted(CREDENTIALS, 'NA', { fetch: server.fetch });
    expect(result).toMatchObject({ received: 3, rejected: [{ index: 2, reason: 'invalid_profile_id' }] });
    expect(result.profiles).toHaveLength(2);
    expect(server.requestsFor('/v2/profiles')).toHaveLength(1);
  });
});

describe('client.getProfiles', () => {
  it('scopes to no profile, because this is the call that finds them', async () => {
    const server = createMockServer([
      lwaRoute(),
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 200, json: PROFILES_NA }] },
    ]);
    const client = new AdsApiClient({ credentials: CREDENTIALS, region: 'NA', fetch: server.fetch });

    const profiles = await client.getProfiles();

    expect(profiles).toHaveLength(2);
    const request = server.requestsFor('/v2/profiles')[0];
    expect(request?.headers['amazon-advertising-api-clientid']).toBe(CREDENTIALS.clientId);
    expect(request?.headers['amazon-advertising-api-scope']).toBeUndefined();
    expect(request?.headers['authorization']).toBe('Bearer fake-access-token');
  });
});

describe('listProfilesAcrossRegions', () => {
  it('keeps what the working regions returned and reports the refusals', async () => {
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'GET',
        match: /advertising-api\.amazon\.com\/v2\/profiles/,
        responses: [{ status: 200, json: PROFILES_NA }],
      },
      {
        method: 'GET',
        match: /advertising-api-eu\.amazon\.com\/v2\/profiles/,
        responses: [{ status: 200, json: PROFILES_EU }],
      },
      {
        method: 'GET',
        match: /advertising-api-fe\.amazon\.com\/v2\/profiles/,
        responses: [{ status: 401, json: { message: 'Unauthorized' } }],
      },
    ]);

    const result = await listProfilesAcrossRegions(CREDENTIALS, {
      fetch: server.fetch,
      sleep: async () => undefined,
    });

    expect(result.regionsQueried).toEqual(['NA', 'EU', 'FE']);
    expect(result.profiles.map((profile) => profile.region)).toEqual(['NA', 'NA', 'EU']);
    expect(result.failures.map((failure) => failure.region)).toEqual(['FE']);
  });

  it('mints one access token for all three hosts, because LWA is global', async () => {
    const server = createMockServer([
      lwaRoute(),
      { method: 'GET', match: /\/v2\/profiles/, responses: [{ status: 200, json: PROFILES_EU }] },
    ]);

    await listProfilesAcrossRegions(CREDENTIALS, { fetch: server.fetch });

    expect(server.requestsFor('/auth/o2/token')).toHaveLength(1);
    expect(server.requestsFor(/\/v2\/profiles/)).toHaveLength(3);
  });
});
