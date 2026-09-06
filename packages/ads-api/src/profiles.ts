/**
 * `GET /v2/profiles`: which advertisers this grant can see.
 *
 * Still v2, still the only way to enumerate profiles, and the first call any
 * new connection makes. WP-04's OAuth callback runs it immediately after the
 * code exchange to populate the profile roster, which is why the entry points
 * here are free functions: at that moment there is a grant and no profile, so
 * there is nothing to scope a client to yet.
 *
 * A grant spans regions and a profile lives on exactly one host, so discovery
 * means asking all three. `listProfilesAcrossRegions` therefore reports
 * per-region failures instead of throwing: an advertiser with only EU accounts
 * gets a 401 from NA and FE, and that is a normal result, not an outage. The
 * reference does the same thing (`test_profiles` prints the failure and
 * continues).
 */
import { AdsProfileDiscoveryResult, type AdsProfileRefusal, type DiscoveredAdsProfile, type Region } from '@wizard-ads/shared';
import { TokenProvider } from './auth.js';
import { createHttpContext, type EffectOptions } from './context.js';
import { AdsApiParseError } from './errors.js';
import { adsHeaders } from './headers.js';
import { decodeText, httpRequest, type HttpContext } from './http.js';
import { ALL_REGIONS, hostFor } from './regions.js';
import { isRecord, readId, readNumber, readRecord, readString } from './read.js';
import type { AdsCredentials } from './types.js';

export type ProfileAccountType = 'seller' | 'vendor' | 'agency';

export type AdsProfile = DiscoveredAdsProfile;

function mapAccountType(value: string | null): ProfileAccountType | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'seller' || normalized === 'vendor' || normalized === 'agency') {
    return normalized;
  }
  return null;
}

/** Compatibility projection. New connection ingestion uses the counted result. */
export function parseProfiles(raw: unknown, region: Region): AdsProfile[] {
  return parseProfilesCounted(raw, region).profiles;
}

/** Every received position is accepted once or explicitly refused, without raw data. */
export function parseProfilesCounted(raw: unknown, region: Region): AdsProfileDiscoveryResult {
  if (!Array.isArray(raw)) {
    throw new AdsApiParseError('GET /v2/profiles did not return a JSON array');
  }
  const accepted = new Map<string, { index: number; profile: AdsProfile }>();
  const duplicated = new Set<string>();
  const rejected: AdsProfileRefusal[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) { rejected.push({ index, reason: 'invalid_row' }); continue; }
    // JSON has already decoded the numeric value. String(...) cannot recover
    // an unsafe integer's original digits; refuse it instead of linking another account.
    if (typeof entry['profileId'] === 'number' && !Number.isSafeInteger(entry['profileId'])) {
      rejected.push({ index, reason: 'unsafe_profile_id' }); continue;
    }
    const profileId = readId(entry, 'profileId');
    if (profileId === null) { rejected.push({ index, reason: 'invalid_profile_id' }); continue; }
    const prior = accepted.get(profileId);
    if (prior !== undefined || duplicated.has(profileId)) {
      if (prior !== undefined) {
        accepted.delete(profileId);
        rejected.push({ index: prior.index, reason: 'duplicate_profile_id' });
      }
      duplicated.add(profileId);
      rejected.push({ index, reason: 'duplicate_profile_id' });
      continue;
    }
    const accountInfo = readRecord(entry, 'accountInfo');
    accepted.set(profileId, { index, profile: {
      profileId,
      region,
      countryCode: readString(entry, 'countryCode'),
      currencyCode: readString(entry, 'currencyCode'),
      timezone: readString(entry, 'timezone'),
      dailyBudget: readNumber(entry, 'dailyBudget'),
      accountType: accountInfo === null ? null : mapAccountType(readString(accountInfo, 'type')),
      accountName: accountInfo === null ? null : readString(accountInfo, 'name'),
      amazonAccountId: accountInfo === null ? null : readId(accountInfo, 'id'),
      marketplaceStringId:
        accountInfo === null ? null : readString(accountInfo, 'marketplaceStringId'),
    } });
  }
  return AdsProfileDiscoveryResult.parse({
    region, received: raw.length, profiles: [...accepted.values()].map((row) => row.profile),
    rejected: rejected.sort((left, right) => left.index - right.index),
  });
}

/** Shared by the client method and the free function. */
export async function fetchProfiles(
  ctx: HttpContext,
  region: Region,
  clientId: string,
  getAccessToken: (force: boolean) => Promise<string>,
  userAgent?: string,
): Promise<AdsProfile[]> {
  return (await fetchProfilesCounted(ctx, region, clientId, getAccessToken, userAgent)).profiles;
}

export async function fetchProfilesCounted(
  ctx: HttpContext,
  region: Region,
  clientId: string,
  getAccessToken: (force: boolean) => Promise<string>,
  userAgent?: string,
): Promise<AdsProfileDiscoveryResult> {
  const result = await httpRequest(ctx, {
    method: 'GET',
    url: `${hostFor(region)}/v2/profiles`,
    path: '/v2/profiles',
    // No `Amazon-Advertising-API-Scope`: this is the call that finds the scopes.
    headers: adsHeaders(getAccessToken, {
      clientId,
      accept: 'application/json',
      ...(userAgent === undefined ? {} : { userAgent }),
    }),
    idempotent: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(result.body));
  } catch (cause) {
    throw new AdsApiParseError('GET /v2/profiles returned a body that is not JSON', cause);
  }
  return parseProfilesCounted(parsed, region);
}

/** Worker connection ingestion receives full counts, including unusable input rows. */
export async function listProfilesCounted(
  credentials: AdsCredentials,
  region: Region,
  options: EffectOptions & { userAgent?: string } = {},
): Promise<AdsProfileDiscoveryResult> {
  const ctx = createHttpContext(region, options);
  const tokens = new TokenProvider(credentials, options);
  return fetchProfilesCounted(ctx, region, credentials.clientId,
    (force) => force ? tokens.forceRefresh() : tokens.getAccessToken(), options.userAgent);
}

/** Every profile this grant can see in one region. */
export async function listProfiles(
  credentials: AdsCredentials,
  region: Region,
  options: EffectOptions & { userAgent?: string } = {},
): Promise<AdsProfile[]> {
  const ctx = createHttpContext(region, options);
  const tokens = new TokenProvider(credentials, options);
  return fetchProfiles(
    ctx,
    region,
    credentials.clientId,
    (force) => (force ? tokens.forceRefresh() : tokens.getAccessToken()),
    options.userAgent,
  );
}

export interface RegionFailure {
  region: Region;
  error: unknown;
}

export interface CrossRegionProfiles {
  profiles: AdsProfile[];
  /** Regions that refused. Usually "this grant has no accounts there". */
  failures: RegionFailure[];
  /** Regions asked. `profiles` spans `regions.length - failures.length` of them. */
  regionsQueried: Region[];
}

/**
 * Discovery across all three hosts, used once per connection.
 *
 * One token provider for all three: LWA is global, so three regions do not need
 * three refreshes.
 */
export async function listProfilesAcrossRegions(
  credentials: AdsCredentials,
  options: EffectOptions & { regions?: readonly Region[]; userAgent?: string } = {},
): Promise<CrossRegionProfiles> {
  const regions = [...(options.regions ?? ALL_REGIONS)];
  const tokens = new TokenProvider(credentials, options);
  const getAccessToken = (force: boolean): Promise<string> =>
    force ? tokens.forceRefresh() : tokens.getAccessToken();

  const profiles: AdsProfile[] = [];
  const failures: RegionFailure[] = [];

  for (const region of regions) {
    const ctx = createHttpContext(region, options);
    try {
      profiles.push(
        ...(await fetchProfiles(ctx, region, credentials.clientId, getAccessToken, options.userAgent)),
      );
    } catch (error) {
      failures.push({ region, error });
    }
  }

  return { profiles, failures, regionsQueried: regions };
}
