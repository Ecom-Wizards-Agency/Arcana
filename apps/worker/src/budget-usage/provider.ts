import { AdsApiClient, type BudgetUsageResult } from '@wizard-ads/ads-api';
import {
  getAdsRefreshTokenForGeneration, getProfileCredentialBinding, type DbHandle,
} from '@wizard-ads/db';
import type { AdProduct } from '@wizard-ads/shared';
import type { AdsProfileContext } from '../ads-api.js';

export interface BudgetUsageProvider {
  read(profile: AdsProfileContext, adProduct: AdProduct, campaignIds: readonly string[]): Promise<BudgetUsageResult>;
}

/** Credentials are resolved only after the collector has checked both activation gates. */
export function createBudgetUsageProvider(handle: DbHandle, env: NodeJS.ProcessEnv = process.env): BudgetUsageProvider {
  return {
    async read(profile, adProduct, campaignIds) {
      const binding = await getProfileCredentialBinding(handle, profile.orgId, profile.id, profile.amazonProfileId, profile.region);
      if (!binding || binding.orgId !== profile.orgId) throw new Error('Budget usage profile credential binding unavailable');
      const refreshToken = await getAdsRefreshTokenForGeneration(handle, binding);
      if (!refreshToken) throw new Error('Budget usage credential generation unavailable');
      const clientId = env['LWA_CLIENT_ID'] ?? env['AMAZON_LWA_CLIENT_ID'];
      const clientSecret = env['LWA_CLIENT_SECRET'] ?? env['AMAZON_LWA_CLIENT_SECRET'];
      if (!clientId || !clientSecret) throw new Error('Budget usage application credentials unavailable');
      const client = new AdsApiClient({ region: profile.region, credentials: { clientId, clientSecret, refreshToken } });
      return client.getBudgetUsage(profile.amazonProfileId, adProduct, campaignIds);
    },
  };
}
