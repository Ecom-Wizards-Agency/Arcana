import { createHash } from 'node:crypto';
import { AssetLibraryObservation, AssetModerationObservation, ProviderGraphAssociation, ProviderGraphObservation, AssetEvidencePersistenceCounts } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Owner { orgId: string; profileId: string }
async function ownerScope(handle: QueryHandle, owner: Owner) {
  const [profile] = await handle.sql<{ amazon_profile_id: string; region: 'EU'|'NA'|'FE'; country_code: string }[]>`
    select amazon_profile_id,region,country_code from public.ad_profiles where org_id=${owner.orgId} and id=${owner.profileId}`;
  if (!profile) throw new Error('Asset profile ownership could not be verified');
  return profile;
}
function checkScope(actual: { region: string; amazonProfileId: string }, expected: { region: string; amazon_profile_id: string }) {
  if (actual.region !== expected.region || actual.amazonProfileId !== expected.amazon_profile_id) throw new Error('Asset profile scope mismatch');
}
function expiry(observedAt: string, expiresAt: string) {
  const duration = Date.parse(expiresAt)-Date.parse(observedAt);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 95*86400000) throw new Error('Asset evidence validity exceeds retention');
}

/** Version content anchors and processing observations commit together with independent readback. */
export async function persistAssetLibraryEvidence(handle: DbHandle, owner: Owner, input: readonly { observation: AssetLibraryObservation; expiresAt: string }[]): Promise<AssetEvidencePersistenceCounts> {
  return handle.sql.begin(async (sql) => {
    const scope = await ownerScope({ sql }, owner); const canonical = new Map<string, { observation: AssetLibraryObservation; expiresAt: string }>();
    for (const raw of input) {
      const observation = AssetLibraryObservation.parse(raw.observation); checkScope(observation.scope, scope); expiry(observation.observedAt, raw.expiresAt);
      canonical.set(fingerprint(observation), { observation, expiresAt: raw.expiresAt });
    }
    let stored = 0;
    for (const [identity, item] of canonical) {
      const { observation: observation, expiresAt } = item; const asset = observation.identity;
      const contentFingerprint = fingerprint({ identity: asset, assetType: observation.assetType, mediaMetadata: observation.mediaMetadata ?? null });
      await sql`insert into public.asset_library_versions(org_id,profile_id,asset_id,version,fingerprint,observation,observed_at)
        values(${owner.orgId},${owner.profileId},${asset.assetId},${asset.version},${contentFingerprint},${JSON.stringify(observation)}::jsonb,${observation.observedAt}) on conflict do nothing`;
      const [anchor] = await sql<{ fingerprint: string }[]>`select fingerprint from public.asset_library_versions where org_id=${owner.orgId} and profile_id=${owner.profileId} and asset_id=${asset.assetId} and version=${asset.version}`;
      if (anchor?.fingerprint !== contentFingerprint) throw new Error('Immutable asset version content conflict');
      const rows = await sql`insert into public.asset_library_observations(org_id,profile_id,identity,asset_id,asset_version,observation,observed_at,expires_at)
        values(${owner.orgId},${owner.profileId},${identity},${asset.assetId},${asset.version},${JSON.stringify(observation)}::jsonb,${observation.observedAt},${expiresAt}) on conflict do nothing returning identity`;
      stored += rows.length;
    }
    const rows = canonical.size === 0 ? [] : await sql<{ identity: string; observation: unknown }[]>`select identity,observation from public.asset_library_observations
      where org_id=${owner.orgId} and profile_id=${owner.profileId} and identity in ${sql([...canonical.keys()])}`;
    if (rows.length !== canonical.size || rows.some((row) => fingerprint(AssetLibraryObservation.parse(row.observation)) !== row.identity)) throw new Error('Asset persisted readback mismatch');
    return AssetEvidencePersistenceCounts.parse({ source: input.length, duplicates: input.length-canonical.size, canonical: canonical.size, stored, existing: canonical.size-stored, verified: rows.length, unresolved: 0 });
  });
}
async function resolvedAsset(handle: QueryHandle, owner: Owner, observation: AssetModerationObservation): Promise<boolean> {
  if (observation.assetIdentity === null || observation.stage !== 'final' || observation.subject.kind === 'component') return false;
  const rows = await handle.sql<{ association: unknown; resolution: string }[]>`select association,resolution from public.provider_entity_associations where org_id=${owner.orgId} and profile_id=${owner.profileId}`;
  const latest = new Map<string, { edge: ProviderGraphAssociation; resolution: string }>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const edge = ProviderGraphAssociation.parse(row.association); const key = JSON.stringify([edge.from,edge.to,edge.relation]); const previous = latest.get(key);
    if (edge.scope.orgId !== owner.orgId || edge.scope.profileId !== owner.profileId
      || edge.scope.region !== observation.context.scope.region || edge.scope.amazonProfileId !== observation.context.scope.amazonProfileId) continue;
    if (!previous || Date.parse(edge.sourceEventAt) > Date.parse(previous.edge.sourceEventAt)
      || (edge.sourceEventAt === previous.edge.sourceEventAt && BigInt(edge.revision ?? '0') > BigInt(previous.edge.revision ?? '0'))) {
      latest.set(key, { edge, resolution: row.resolution }); conflicts.delete(key);
    } else if (edge.sourceEventAt === previous.edge.sourceEventAt && BigInt(edge.revision ?? '0') === BigInt(previous.edge.revision ?? '0')
      && (edge.payloadFingerprint !== previous.edge.payloadFingerprint || edge.operation !== previous.edge.operation)) conflicts.add(key);
  }
  const nodeRows = await handle.sql<{ observation: unknown }[]>`select observation from public.provider_graph_observations where org_id=${owner.orgId} and profile_id=${owner.profileId}`;
  const nodes = new Map<string, ProviderGraphObservation>(); const nodeConflicts = new Set<string>();
  for (const row of nodeRows) {
    const node = ProviderGraphObservation.parse(row.observation); const key = JSON.stringify(node.identity); const previous = nodes.get(key);
    if (node.scope.orgId !== owner.orgId || node.scope.profileId !== owner.profileId
      || node.scope.region !== observation.context.scope.region || node.scope.amazonProfileId !== observation.context.scope.amazonProfileId) continue;
    if (!previous || Date.parse(node.sourceEventAt) > Date.parse(previous.sourceEventAt)
      || (node.sourceEventAt === previous.sourceEventAt && BigInt(node.revision ?? '0') > BigInt(previous.revision ?? '0'))) {
      nodes.set(key, node); nodeConflicts.delete(key);
    } else if (node.sourceEventAt === previous.sourceEventAt && BigInt(node.revision ?? '0') === BigInt(previous.revision ?? '0')
      && (node.payloadFingerprint !== previous.payloadFingerprint || node.operation !== previous.operation)) nodeConflicts.add(key);
  }
  const product = observation.context.program.startsWith('SB_') || observation.context.program.startsWith('SPONSORED_BRANDS') ? 'SB' : observation.context.program === 'SPONSORED_DISPLAY' ? 'SD' : 'SP';
  const edges = [...latest.entries()].filter(([key, row]) => !conflicts.has(key) && row.resolution === 'resolved'
    && row.edge.operation === 'upsert' && row.edge.from.adProduct === product
    && [row.edge.from,row.edge.to].every((identity) => { const key = JSON.stringify(identity); const node = nodes.get(key);
      return node !== undefined && !nodeConflicts.has(key) && node.operation === 'upsert'; })).map(([, row]) => row.edge);
  const subject = observation.subject;
  const starts = edges.filter((edge) => subject.kind === 'ad'
    ? edge.from.kind === 'ad' && edge.from.providerId === subject.adId && edge.from.version === subject.adVersion
    : edge.from.kind === 'creative' && edge.from.providerId === subject.creativeId && subject.creativeVersion !== null && edge.from.version === subject.creativeVersion);
  const reachesAsset = (edge: ProviderGraphAssociation) => edge.to.kind === 'asset' && edge.to.providerId === observation.assetIdentity!.assetId && edge.to.version === observation.assetIdentity!.version;
  if (starts.some(reachesAsset)) return true;
  return starts.some((start) => start.to.kind === 'creative' && edges.some((edge) => JSON.stringify(edge.from) === JSON.stringify(start.to) && reachesAsset(edge)));
}

/** Unresolved moderation stays durable at ad/creative grain and cannot approve an asset. */
export async function persistAssetModerationEvidence(handle: DbHandle, owner: Owner, input: readonly { observation: AssetModerationObservation; expiresAt: string }[]): Promise<AssetEvidencePersistenceCounts> {
  return handle.sql.begin(async (sql) => {
    const scope = await ownerScope({ sql }, owner); const canonical = new Map<string, { observation: AssetModerationObservation; expiresAt: string }>();
    for (const raw of input) {
      const observation = AssetModerationObservation.parse(raw.observation); checkScope(observation.context.scope, scope);
      if (observation.context.marketplace !== scope.country_code) throw new Error('Moderation marketplace does not match profile');
      expiry(observation.observedAt, raw.expiresAt);
      if (!await resolvedAsset({ sql }, owner, observation)) observation.assetIdentity = null;
      canonical.set(fingerprint(observation), { observation, expiresAt: raw.expiresAt });
    }
    let stored = 0; let unresolved = 0;
    for (const [identity, { observation, expiresAt }] of canonical) {
      if (observation.assetIdentity === null) unresolved++;
      const rows = await sql`insert into public.asset_moderation_observations(org_id,profile_id,identity,asset_id,asset_version,observation,observed_at,expires_at)
        values(${owner.orgId},${owner.profileId},${identity},${observation.assetIdentity?.assetId ?? null},${observation.assetIdentity?.version ?? null},${JSON.stringify(observation)}::jsonb,${observation.observedAt},${expiresAt}) on conflict do nothing returning identity`;
      stored += rows.length;
    }
    const rows = canonical.size === 0 ? [] : await sql<{ identity: string; observation: unknown }[]>`select identity,observation from public.asset_moderation_observations
      where org_id=${owner.orgId} and profile_id=${owner.profileId} and identity in ${sql([...canonical.keys()])}`;
    if (rows.length !== canonical.size || rows.some((row) => fingerprint(AssetModerationObservation.parse(row.observation)) !== row.identity)) throw new Error('Moderation persisted readback mismatch');
    return AssetEvidencePersistenceCounts.parse({ source: input.length, duplicates: input.length-canonical.size, canonical: canonical.size, stored, existing: canonical.size-stored, verified: rows.length, unresolved });
  });
}

export async function readAssetEvidence(handle: QueryHandle, owner: Owner & { now: string }): Promise<{
  assets: AssetLibraryObservation[]; assetObservations: { observation: AssetLibraryObservation; expiresAt: string }[]; moderationObservations: { observation: AssetModerationObservation; expiresAt: string }[]; assetCount: number; moderationCount: number; unresolvedCount: number; refusedCount: number;
}> {
  const scope = await ownerScope(handle, owner);
  // Older migration-window tests and staged releases remain readable before this additive migration.
  const [installed] = await handle.sql<{ installed: boolean }[]>`select to_regclass('public.asset_library_observations') is not null as installed`;
  if (!installed?.installed) return { assets: [], assetObservations: [], moderationObservations: [], assetCount: 0, moderationCount: 0, unresolvedCount: 0, refusedCount: 0 };
  const [assetRows, moderationRows] = await Promise.all([
    handle.sql<{ observation: unknown; expires_at: Date }[]>`select observation,expires_at from (
      select observation,expires_at,dense_rank() over(partition by asset_id,asset_version order by observed_at desc) as latest_rank
      from public.asset_library_observations where org_id=${owner.orgId} and profile_id=${owner.profileId}) latest where latest_rank=1`,
    handle.sql<{ observation: unknown; expires_at: Date }[]>`select observation,expires_at from public.asset_moderation_observations where org_id=${owner.orgId} and profile_id=${owner.profileId}`,
  ]);
  let refusedCount = 0;
  const parsedAssets = assetRows.flatMap((row) => {
    const parsed = AssetLibraryObservation.safeParse(row.observation);
    if (!parsed.success || parsed.data.scope.region !== scope.region || parsed.data.scope.amazonProfileId !== scope.amazon_profile_id) { refusedCount++; return []; }
    return [{ observation: parsed.data, expiresAt: new Date(row.expires_at).toISOString() }];
  });
  const assets = parsedAssets.filter((row) => {
    const matches = parsedAssets.filter((other) => JSON.stringify(other.observation.identity) === JSON.stringify(row.observation.identity));
    if (matches.length > 1) { refusedCount++; return false; }
    return true;
  });
  const moderation = moderationRows.flatMap((row) => {
    const parsed = AssetModerationObservation.safeParse(row.observation);
    if (!parsed.success || parsed.data.context.scope.region !== scope.region || parsed.data.context.scope.amazonProfileId !== scope.amazon_profile_id
      || parsed.data.context.marketplace !== scope.country_code) { refusedCount++; return []; }
    return [{ observation: parsed.data, expiresAt: new Date(row.expires_at).toISOString() }];
  });
  for (const row of moderation) if (row.observation.assetIdentity !== null && !await resolvedAsset(handle, owner, row.observation)) row.observation.assetIdentity = null;
  return { assets: assets.map((item) => item.observation), assetObservations: assets, moderationObservations: moderation,
    assetCount: assets.length, moderationCount: moderation.length,
    unresolvedCount: moderation.filter((item) => item.observation.assetIdentity === null).length, refusedCount };
}
