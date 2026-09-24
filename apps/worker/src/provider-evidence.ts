import { providerEvidenceEnabledFromEnv } from './config.js';
import { marketplaceIdForCountry } from './marketplaces.js';
import { AdsApiClient, ProviderEvidenceProtocolError, providerReadContract } from '@wizard-ads/ads-api';
import { getAdsRefreshTokenForGeneration, getProfileCredentialBinding, type DbHandle } from '@wizard-ads/db';
import { prepareProviderEvidenceRun, authorizeProviderEvidencePage, persistProviderEvidencePage, failProviderEvidenceRun } from '@wizard-ads/db/worker';
import type { ProviderCollectionConfig, ProviderEvidencePage, ProviderEvidenceRun } from '@wizard-ads/shared';
import type { IngestionRegistry } from './ingestion-registry.js';
import type { AdsProfileContext } from './ads-api.js';
import { PermanentJobError } from './permanent-job-error.js';

export interface ProviderEvidenceDependencies {
  enabled(): boolean;
  prepare(scope: { orgId: string; profileId: string; configId: string; runId: string }): Promise<ProviderEvidenceRun>;
  authorize(run: ProviderEvidenceRun): Promise<void>;
  fail(run: ProviderEvidenceRun): Promise<void>;
  persist(run: ProviderEvidenceRun, page: ProviderEvidencePage): Promise<ProviderEvidenceRun>;
  read(config: ProviderCollectionConfig, nextToken: string | null, profile: AdsProfileContext): Promise<ProviderEvidencePage>;
}
/** One typed dispatcher; operation descriptors are bounded read-only contracts. */
export function registerProviderEvidence(registry: Pick<IngestionRegistry, 'register'>, deps: ProviderEvidenceDependencies): void {
  registry.register({
    source: { jobType: 'provider.evidence.collect', source: 'amazon_provider_evidence', laneAffinity: ['integrations'], counts: ['source', 'parsed', 'refused', 'canonical', 'readback'] },
    async plan({ job, payload, profile }) {
      if (!deps.enabled()) throw new PermanentJobError('Provider evidence collection is disabled');
      const run = await deps.prepare({ orgId: job.orgId, profileId: job.profileId, runId: job.id, configId: payload.configId });
      try {
      if (run.config.scope.orgId !== profile.orgId || run.config.scope.profileId !== profile.id || run.config.scope.amazonProfileId !== profile.amazonProfileId) throw new PermanentJobError('Provider evidence profile mismatch');
      if (providerReadContract(run.config.operation).family !== run.config.family) throw new PermanentJobError('Provider evidence family mismatch');
      return run;
      } catch { await deps.fail(run); throw new PermanentJobError('Provider evidence configuration or scope refused'); }
    },
    async execute(initial, { profile }) {
      let run = initial;
      const seen = new Set<string>();
      try {
      while (run.status === 'running') {
        if (!deps.enabled()) throw new PermanentJobError('Provider evidence collection is disabled');
        if (run.page >= run.config.maxPages) throw new PermanentJobError('Provider evidence page limit reached; checkpoint retained');
        if (run.nextToken !== null) {
          if (seen.has(run.nextToken)) throw new PermanentJobError('Provider evidence pagination cycle');
          seen.add(run.nextToken);
        }
        await deps.authorize(run);
        run = await deps.persist(run, await deps.read(run.config, run.nextToken, profile));
      }
      } catch (error) {
        await deps.fail(run);
        if (error instanceof PermanentJobError || error instanceof ProviderEvidenceProtocolError) throw new PermanentJobError('Provider evidence retrieval refused; checkpoint retained');
        // eslint-disable-next-line preserve-caught-error -- Provider causes can contain credentials, signed URLs and customer payloads.
        throw new Error('Provider evidence retrieval failed; checkpoint retained');
      }
      return { run };
    },
    counts: ({ run }) => ({ sourceRows: run.counts.source, parsedRows: run.counts.parsed, refusedRows: run.counts.refused, loadedRows: run.counts.canonical, verifiedLoadedRows: run.counts.readback }),
    coverage: { target: ({ run }) => ({ reportType: `provider_evidence:${run.config.family}`, grain: `scope:${run.config.id}`, status: run.status === 'complete' && (run.earliestExpiry == null || Date.parse(run.earliestExpiry) > Date.now()) ? 'complete' : 'partial', earliestDate: run.observedAt.slice(0, 10), coveredThrough: run.observedAt.slice(0, 10), settledThrough: null, observedAt: run.observedAt }) },
  });
}
export function postgresProviderEvidenceDependencies(handle: DbHandle, env: NodeJS.ProcessEnv = process.env): ProviderEvidenceDependencies {
  return {
    enabled: () => providerEvidenceEnabledFromEnv(env),
    prepare: async (scope) => {
      const run = await prepareProviderEvidenceRun(handle, scope);
      const [profile] = await handle.sql<{ country_code: string }[]>`select country_code from public.ad_profiles where org_id=${scope.orgId} and id=${scope.profileId}`;
      if (!profile || marketplaceIdForCountry(profile.country_code) !== run.config.scope.marketplaceId || run.config.scope.countryCode !== undefined && run.config.scope.countryCode !== profile.country_code) {
        await failProviderEvidenceRun(handle, run);
        throw new PermanentJobError('Provider marketplace mismatch');
      }
      return run;
    },
    authorize: (run) => authorizeProviderEvidencePage(handle, run),
    fail: (run) => failProviderEvidenceRun(handle, run),
    persist: (run, page) => persistProviderEvidencePage(handle, run, page),
    async read(config, nextToken, profile) {
      const binding = await getProfileCredentialBinding(handle, profile.orgId, profile.id, profile.amazonProfileId, profile.region);
      if (!binding || binding.orgId !== profile.orgId) throw new Error('Provider evidence connection unavailable');
      const refreshToken = await getAdsRefreshTokenForGeneration(handle, binding);
      const clientId = env['LWA_CLIENT_ID'] ?? env['AMAZON_LWA_CLIENT_ID'];
      const clientSecret = env['LWA_CLIENT_SECRET'] ?? env['AMAZON_LWA_CLIENT_SECRET'];
      if (!refreshToken || !clientId || !clientSecret) throw new Error('Provider evidence credentials unavailable');
      return new AdsApiClient({ region: profile.region, credentials: { clientId, clientSecret, refreshToken } }).readProviderEvidence(config, nextToken);
    },
  };
}
