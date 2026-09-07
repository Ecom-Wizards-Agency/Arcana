import { ADS_SCOPE, AdsAuthError, exchangeAuthorizationCode, listProfilesCounted } from '@wizard-ads/ads-api';
import { getAdsRefreshTokenForGeneration, type DbHandle } from '@wizard-ads/db';
import { attachAmazonConnectionGrant, claimAmazonConnection, failAmazonConnectionDiscovery,
  failAmazonConnectionExchange, readAmazonConnectionWorker, recordAmazonConnectionRegion,
  startAmazonConnectionRegion } from '@wizard-ads/db/worker';
import { AmazonConnectionInstallation } from '@wizard-ads/shared';
import type { AmazonConnectionProvider, AmazonConnectionStore } from './amazon-connections.js';

export function createAmazonConnectionStore(handle: Pick<DbHandle, 'sql'>): AmazonConnectionStore {
  return {
    claim: (lease) => claimAmazonConnection(handle, lease),
    attach: (operation, lease, token) => attachAmazonConnectionGrant(handle, operation, lease, token),
    failExchange: (operation, lease, reason) => failAmazonConnectionExchange(handle, operation, lease, reason),
    failDiscovery: (operation, lease) => failAmazonConnectionDiscovery(handle, operation, lease),
    read: (operation) => readAmazonConnectionWorker(handle, operation),
    startRegion: (operation, lease, region) => startAmazonConnectionRegion(handle, operation, lease, region),
    recordRegion: (operation, lease, region, input, failure) =>
      recordAmazonConnectionRegion(handle, operation, lease, region, input, failure),
  };
}

/** Deployment configuration is validated without echoing any value or parser input. */
export function createAmazonConnectionProvider(
  handle: Pick<DbHandle, 'sql'>,
  env: NodeJS.ProcessEnv = process.env,
  effects: Pick<Parameters<typeof exchangeAuthorizationCode>[1] & object, 'fetch' | 'sleep' | 'now' | 'random'> = {},
): AmazonConnectionProvider {
  const clientId = env['LWA_CLIENT_ID'] ?? env['AMAZON_LWA_CLIENT_ID'];
  const clientSecret = env['LWA_CLIENT_SECRET'] ?? env['AMAZON_LWA_CLIENT_SECRET'];
  const rawRedirects = env['AMAZON_OAUTH_ALLOWED_REDIRECT_URIS'] ?? env['AMAZON_OAUTH_REDIRECT_URI'];
  if (!clientId || !clientSecret || !rawRedirects) throw new Error('Amazon connection application is not configured');
  const redirects = rawRedirects.split(',').map((value) => value.trim());
  if (redirects.length > 10 || redirects.some((redirectUri) => !AmazonConnectionInstallation.safeParse({
    clientId, scope: ADS_SCOPE, redirectUri,
  }).success)) throw new Error('Amazon connection callback configuration is invalid');
  const accepts: AmazonConnectionProvider['accepts'] = (installation) =>
    installation.clientId === clientId && installation.scope === ADS_SCOPE && redirects.includes(installation.redirectUri);
  return {
    accepts,
    exchange: async (installation, code, signal) => {
      if (!accepts(installation)) throw new Error('Amazon connection installation changed');
      signal.throwIfAborted();
      const tokens = await exchangeAuthorizationCode({ clientId, clientSecret, code,
        redirectUri: installation.redirectUri }, { ...effects, signal });
      return tokens.refreshToken;
    },
    discover: async (binding, region, signal) => {
      signal.throwIfAborted();
      // Every regional read rechecks the complete grant generation. A rotated
      // pointer cannot reuse a token cached under the previous agency binding.
      const refreshToken = await getAdsRefreshTokenForGeneration(handle, binding);
      if (!refreshToken) throw new AdsAuthError('Amazon connection authority changed', 401, '', 0);
      signal.throwIfAborted();
      return listProfilesCounted({ clientId, clientSecret, refreshToken }, region, { ...effects, signal });
    },
  };
}
