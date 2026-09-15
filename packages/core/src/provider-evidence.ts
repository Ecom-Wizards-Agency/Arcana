import { ProviderEvidenceSnapshot, PROVIDER_DEFERRED_EXTENSIONS, PROVIDER_FAMILY_CONSUMERS, type ArcanaEvidenceBaseline, type ProviderAvailability, type ProviderComparison, type ProviderRecommendation, type ProviderEvidenceReadResult, type ProviderEvidenceConsumer, type ProviderEvidenceFamily } from '@wizard-ads/shared';

/** Exact compatibility is required; provider objectives never alter tenant strategy. */
export function compareProviderEvidence(provider: ProviderRecommendation, arcana: ArcanaEvidenceBaseline | null, now: string): ProviderComparison {
  const result = (reason: string): ProviderComparison => ({ status: 'not-comparable', reason, amazon: provider.proposed, arcana: arcana?.proposed ?? null });
  if (provider.expiresAt !== null && Date.parse(provider.expiresAt) <= Date.parse(now)) return result('Provider recommendation expired');
  if (!arcana) return result('No comparable Arcana baseline');
  if (!['bid', 'budget', 'headline', 'target'].includes(provider.action)) return result('Unsupported action');
  if (provider.entity.mapping !== 'mapped' || arcana.entity.mapping !== 'mapped' || !provider.entity.entityId ||
      ['orgId', 'profileId', 'marketplaceId'].some((key) => provider.scope[key as keyof typeof provider.scope] !== arcana.scope[key as keyof typeof arcana.scope]) ||
      JSON.stringify(provider.entity) !== JSON.stringify(arcana.entity)) return result('Entity or account scope differs');
  if (provider.action !== arcana.action || provider.objective === null || provider.objective !== arcana.objective ||
      provider.horizon === null || provider.horizon !== arcana.horizon || provider.attribution !== arcana.attribution) return result('Objective or horizon differs or is unknown');
  if ([provider.current, provider.proposed, arcana.current, arcana.proposed].some((v) => v.value === null || v.units === null)) return result('Missing value, units or baseline');
  if (['bid','budget'].includes(provider.action) && (provider.proposed.currency === null || arcana.proposed.currency === null)) return result('Currency is unknown');
  if (provider.current.value !== arcana.current.value || provider.observedAt !== arcana.observedAt) return result('Observed baseline differs');
  if ([provider.current, arcana.current, arcana.proposed].some((v) => v.units !== provider.proposed.units || v.currency !== provider.proposed.currency)) return result('Units or currency differ');
  return { status: provider.proposed.value === arcana.proposed.value ? 'agrees' : 'disagrees', reason: 'Same entity, action, units, horizon and observed baseline', amazon: provider.proposed, arcana: arcana.proposed };
}

export function providerEvidenceAvailability(input: { status: string; observedAt: string | null; expiresAt: string | null }, now: string, staleAfterMs: number): ProviderAvailability {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0 || !Number.isFinite(Date.parse(now))) throw new Error('Invalid provider availability clock');
  if (input.status === 'unsupported') return 'unsupported';
  if (input.observedAt === null) return 'not-measured';
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.parse(now)) return 'expired';
  if (Date.parse(now) - Date.parse(input.observedAt) > staleAfterMs) return 'stale';
  return input.status === 'complete' ? 'measured' : 'partial';
}

export function providerEvidenceSnapshot(input: ProviderEvidenceReadResult, consumer: ProviderEvidenceConsumer, now: string): ProviderEvidenceSnapshot {
  const rows = input.rows.map((recommendation) => ({ recommendation,
    availability: providerEvidenceAvailability({ status: 'complete', observedAt: recommendation.observedAt, expiresAt: recommendation.expiresAt }, now, recommendation.family.includes('forecast') ? 8 * 86400000 : 2 * 86400000),
    comparison: compareProviderEvidence(recommendation, input.arcana?.find((a) => a.entity.entityId === recommendation.entity.entityId && a.entity.entityType === recommendation.entity.entityType && a.entity.adProduct === recommendation.entity.adProduct && a.action === recommendation.action) ?? null, now),
  }));
  const families = (Object.keys(PROVIDER_FAMILY_CONSUMERS) as ProviderEvidenceFamily[]).filter((family) => consumer === 'sync-status' || PROVIDER_FAMILY_CONSUMERS[family].includes(consumer)).map((family) => {
    const latest = new Map<string, ProviderEvidenceReadResult['runs'][number]>();
    for (const candidate of input.runs.filter((r) => r.family === family).sort((a,b) => b.startedAt.localeCompare(a.startedAt))) {
      const key = candidate.configId ?? family;
      if (!latest.has(key)) latest.set(key, candidate);
    }
    const scopes = [...latest.values()];
    const first = scopes[0];
    const counts = first ? { ...first.counts } : null;
    if (counts) for (const scope of scopes.slice(1)) for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += scope.counts[key];
    const run = first ? { ...first, counts: counts!, status: scopes.every((r) => r.status === 'complete') ? 'complete' : scopes.every((r) => r.status === 'unsupported') ? 'unsupported' : 'partial', observedAt: scopes.map((r) => r.observedAt).sort()[0]! } : null;
    const expiresAt = scopes.length && scopes.every((r) => r.counts.canonical > 0 && r.expiresAt != null) ? scopes.map((r) => r.expiresAt!).sort().at(-1)! : null;
    return { family, counts: run?.counts ?? null, observedAt: run?.observedAt ?? null,
      availability: providerEvidenceAvailability({ status: run?.status ?? 'missing', observedAt: run?.observedAt ?? null, expiresAt }, now, family.includes('forecast') ? 8 * 86400000 : 2 * 86400000),
      reason: run ? `Amazon retrieval: ${run.status}` : PROVIDER_DEFERRED_EXTENSIONS.find((extension) => extension.family === family)?.reason ?? 'Not measured; source requires explicit configuration and a supported contract',
    };
  });
  return ProviderEvidenceSnapshot.parse({ rows, families, returnedCount: rows.length, totalCount: input.totalCount, truncated: rows.length < input.totalCount });
}
