import { createHash } from 'node:crypto';
import { ProviderGraphAssociation, ProviderGraphIntakeReceipt, ProviderGraphObservation,
  ProviderGraphReadResult, ProviderGraphStoredEvidence, providerGraphIdentityKey, type ProviderGraphScope } from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { QueryHandle, QuerySql } from '../client.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function observationId(row: ProviderGraphObservation): string {
  const { observedAt: _received, ...immutable } = row; return hash(immutable);
}
function associationId(row: ProviderGraphAssociation): string { return hash(row); }
const scopeMatches = (a: ProviderGraphScope, b: ProviderGraphScope): boolean =>
  a.orgId === b.orgId && a.profileId === b.profileId && a.amazonProfileId === b.amazonProfileId && a.region === b.region;

/** Retained evidence is immutable. A duplicate intake cannot advance observation time or retention. */
export async function appendProviderGraphEvidence(handle: QueryHandle, scope: ProviderGraphScope,
  raw: ProviderGraphReadResult): Promise<ProviderGraphIntakeReceipt> {
  const input = ProviderGraphReadResult.parse(raw);
  if ([...input.observations, ...input.associations].some((row) => !scopeMatches(row.scope, scope))) {
    throw new Error('Graph intake scope mismatch');
  }
  const observations = new Map(input.observations.map((row) => [observationId(row), row]));
  const associations = new Map(input.associations.map((row) => [associationId(row), row]));
  const write = async (sql: postgres.TransactionSql): Promise<ProviderGraphIntakeReceipt> => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`provider-graph:${scope.orgId}:${scope.profileId}`},0))`;
    const profiles = await sql`select id from public.ad_profiles where org_id=${scope.orgId}
      and id=${scope.profileId} and amazon_profile_id=${scope.amazonProfileId} and region=${scope.region}`;
    if (profiles.length !== 1) throw new Error('Graph intake advertiser/profile/region binding mismatch');
    let storedObservations = 0; let storedAssociations = 0;
    for (const [id, row] of observations) {
      const written = await sql`insert into public.provider_graph_observations
        (org_id,profile_id,identity,entity_key,observation,source_event_at,observed_at,expires_at)
        values (${scope.orgId},${scope.profileId},${id},${providerGraphIdentityKey(scope,row.identity)},
          ${JSON.stringify(row)}::jsonb,${row.sourceEventAt},${row.observedAt},${row.observedAt}::timestamptz+interval '95 days')
        on conflict(org_id,profile_id,identity) do nothing returning identity`;
      storedObservations += written.length;
    }
    for (const [id, row] of associations) {
      const written = await sql`insert into public.provider_entity_associations
        (org_id,profile_id,identity,association,resolution,observed_at,expires_at)
        values (${scope.orgId},${scope.profileId},${id},${JSON.stringify(row)}::jsonb,
          ${row.operation === 'tombstone' ? 'tombstoned' : 'unresolved'},${row.sourceEventAt},${row.sourceEventAt}::timestamptz+interval '95 days')
        on conflict(org_id,profile_id,identity) do nothing returning identity`;
      storedAssociations += written.length;
    }
    const persistedObservations = observations.size === 0 ? [] : await sql<{ observation: unknown }[]>`
      select observation from public.provider_graph_observations where org_id=${scope.orgId}
        and profile_id=${scope.profileId} and identity in ${sql([...observations.keys()])}`;
    const persistedAssociations = associations.size === 0 ? [] : await sql<{ association: unknown }[]>`
      select association from public.provider_entity_associations where org_id=${scope.orgId}
        and profile_id=${scope.profileId} and identity in ${sql([...associations.keys()])}`;
    if (persistedObservations.length !== observations.size || persistedAssociations.length !== associations.size
      || persistedObservations.some((row) => !observations.has(observationId(ProviderGraphObservation.parse(row.observation))))
      || persistedAssociations.some((row) => !associations.has(associationId(ProviderGraphAssociation.parse(row.association))))) {
      throw new Error('Provider graph independent readback differs from intake');
    }
    return ProviderGraphIntakeReceipt.parse({ observations: { source: input.sourceRows, parsed: input.parsed,
      refused: input.refusals.length, duplicates: input.parsed - observations.size, canonical: observations.size,
      stored: storedObservations, existing: observations.size - storedObservations, verified: persistedObservations.length },
    associations: { source: input.associations.length, parsed: input.associations.length, refused: 0,
      duplicates: input.associations.length - associations.size, canonical: associations.size,
      stored: storedAssociations, existing: associations.size - storedAssociations, verified: persistedAssociations.length } });
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(write) : handle.sql.begin(write);
}

export async function readProviderGraphEvidence(handle: QueryHandle, scope: ProviderGraphScope,
  at: string): Promise<ProviderGraphStoredEvidence> {
  const read = async (sql: QuerySql): Promise<ProviderGraphStoredEvidence> => {
    const rows = await sql<{ observation: unknown }[]>`select observation from public.provider_graph_observations
      where org_id=${scope.orgId} and profile_id=${scope.profileId} and expires_at>${at}
        and source_event_at<=${at} and observed_at<=${at}
      order by source_event_at,observed_at,identity`;
    const edges = await sql<{ association: unknown }[]>`select association from public.provider_entity_associations
      where org_id=${scope.orgId} and profile_id=${scope.profileId} and expires_at>${at}
        and observed_at<=${at} order by observed_at,identity`;
    const observations = rows.map((r) => ProviderGraphObservation.parse(r.observation));
    const associations = edges.map((r) => ProviderGraphAssociation.parse(r.association));
    if ([...observations,...associations].some((r) => !scopeMatches(r.scope,scope))) throw new Error('Stored graph scope mismatch');
    return ProviderGraphStoredEvidence.parse({ observations, associations,
      persistedObservations: rows.length, persistedAssociations: edges.length });
  };
  return read(handle.sql);
}

/** Derived resolution is replaceable; payloads and intake timestamps are never overwritten. */
export async function recordProviderGraphResolution(handle: QueryHandle, scope: ProviderGraphScope,
  resolved: readonly ProviderGraphAssociation[], expected: ProviderGraphStoredEvidence, at: string): Promise<{ offered: number; verified: number }> {
  const unique = new Map(resolved.map((edge) => [associationId(ProviderGraphAssociation.parse(edge)),edge]));
  if (unique.size !== resolved.length || resolved.some((r) => !scopeMatches(r.scope,scope) || r.operation !== 'upsert')) {
    throw new Error('Invalid graph resolution scope or duplicate edge');
  }
  const write = async (sql: postgres.TransactionSql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`provider-graph:${scope.orgId}:${scope.profileId}`},0))`;
    const actual = await readProviderGraphEvidence({ sql },scope,at);
    const keys = (evidence: ProviderGraphStoredEvidence): string => JSON.stringify([
      evidence.observations.map(observationId).sort(), evidence.associations.map(associationId).sort(),
    ]);
    if (keys(actual) !== keys(ProviderGraphStoredEvidence.parse(expected))) throw new Error('Graph projection snapshot changed');
    // An empty result also clears earlier projections that are now stale or conflicting.
    await sql`update public.provider_entity_associations set resolution='unresolved'
      where org_id=${scope.orgId} and profile_id=${scope.profileId} and resolution='resolved'`;
    for (const [id,edge] of unique) {
      for (const endpoint of [edge.from,edge.to]) {
        const nodes = await sql<{ observation: unknown }[]>`select observation from public.provider_graph_observations
          where org_id=${scope.orgId} and profile_id=${scope.profileId} and entity_key=${providerGraphIdentityKey(scope,endpoint)}
            and source_event_at<=${at} and observed_at<=${at} and expires_at>${at}
          order by source_event_at desc,observed_at desc`;
        if (nodes.length === 0 || ProviderGraphObservation.parse(nodes[0]!.observation).operation !== 'upsert') {
          throw new Error('Graph resolution has no verified active endpoint');
        }
      }
      const written = await sql`update public.provider_entity_associations set resolution='resolved'
        where org_id=${scope.orgId} and profile_id=${scope.profileId} and identity=${id} returning identity`;
      if (written.length !== 1) throw new Error('Graph resolution has no durable edge');
    }
    const verified = await sql`select identity from public.provider_entity_associations
      where org_id=${scope.orgId} and profile_id=${scope.profileId} and resolution='resolved'`;
    if (verified.length !== unique.size) throw new Error('Graph resolution independent count differs');
    return { offered: unique.size, verified: verified.length };
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(write) : handle.sql.begin(write);
}
