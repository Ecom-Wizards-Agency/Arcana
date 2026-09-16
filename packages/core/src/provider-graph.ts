import { ProviderGraphAssociation, ProviderGraphObservation, providerGraphIdentityKey,
  type ProviderGraphScope } from '@wizard-ads/shared';

type Clock = Pick<ProviderGraphObservation, 'sourceEventAt' | 'revision' | 'payloadFingerprint' | 'operation'>;
/** Opaque revisions are refused by the shared contract. Equal revisions never win by arrival time. */
export function compareProviderGraphEvidence(incoming: Clock, current: Clock): 'newer' | 'older' | 'duplicate' | 'conflict' {
  if (incoming.revision !== null && current.revision !== null) {
    const next = BigInt(incoming.revision); const prior = BigInt(current.revision);
    if (next !== prior) return next > prior ? 'newer' : 'older';
    return incoming.payloadFingerprint === current.payloadFingerprint
      && incoming.operation === current.operation ? 'duplicate' : 'conflict';
  }
  const next = Date.parse(incoming.sourceEventAt); const prior = Date.parse(current.sourceEventAt);
  if (next !== prior) return next > prior ? 'newer' : 'older';
  return incoming.payloadFingerprint === current.payloadFingerprint
    && incoming.operation === current.operation ? 'duplicate' : 'conflict';
}

function associationKey(edge: ProviderGraphAssociation): string {
  return JSON.stringify([providerGraphIdentityKey(edge.scope, edge.from),
    providerGraphIdentityKey(edge.scope, edge.to), edge.relation]);
}

/** Replay all retained observations plus new arrivals. Partial inventories never remove prior nodes. */
export function reconcileProviderGraph(input: {
  scope: ProviderGraphScope;
  observations: readonly ProviderGraphObservation[];
  associations: readonly ProviderGraphAssociation[];
}): {
  nodes: ProviderGraphObservation[]; tombstones: ProviderGraphObservation[];
  resolved: ProviderGraphAssociation[];
  unresolved: { association: ProviderGraphAssociation; reason: 'missing_endpoint' | 'tombstoned_endpoint' | 'conflicting_endpoint' | 'stale_association' }[];
  duplicates: number; stale: number; conflicts: number; refusedScope: number;
} {
  const nodes = new Map<string, ProviderGraphObservation>();
  const edges = new Map<string, ProviderGraphAssociation>();
  const conflictNodes = new Set<string>(); const conflictEdges = new Set<string>();
  let duplicates = 0; let stale = 0; let conflicts = 0; let refusedScope = 0;
  const matchesScope = (scope: ProviderGraphScope): boolean => scope.orgId === input.scope.orgId
    && scope.profileId === input.scope.profileId && scope.amazonProfileId === input.scope.amazonProfileId
    && scope.region === input.scope.region;
  for (const value of input.observations) {
    const row = ProviderGraphObservation.parse(value);
    if (!matchesScope(row.scope)) { refusedScope++; continue; }
    const key = providerGraphIdentityKey(row.scope, row.identity); const prior = nodes.get(key);
    if (!prior) { nodes.set(key, row); continue; }
    // Revision sequences from separate transports are not necessarily comparable.
    const precedence = prior.source === row.source ? compareProviderGraphEvidence(row, prior)
      : compareProviderGraphEvidence({ ...row, revision: null }, { ...prior, revision: null });
    if (precedence === 'newer') { nodes.set(key, row); conflictNodes.delete(key); }
    else if (precedence === 'older') stale++;
    else if (precedence === 'duplicate') duplicates++;
    else { conflicts++; conflictNodes.add(key); }
  }
  for (const value of input.associations) {
    const edge = ProviderGraphAssociation.parse(value);
    if (!matchesScope(edge.scope)) { refusedScope++; continue; }
    const key = associationKey(edge); const prior = edges.get(key);
    if (!prior) { edges.set(key, edge); continue; }
    const precedence = compareProviderGraphEvidence(edge, prior);
    if (precedence === 'newer') { edges.set(key, edge); conflictEdges.delete(key); }
    else if (precedence === 'older') stale++;
    else if (precedence === 'duplicate') duplicates++;
    else { conflicts++; conflictEdges.add(key); }
  }
  const resolved: ProviderGraphAssociation[] = [];
  const unresolved: ReturnType<typeof reconcileProviderGraph>['unresolved'] = [];
  for (const [key, edge] of edges) {
    if (edge.operation === 'tombstone' && !conflictEdges.has(key)) continue;
    const fromKey = providerGraphIdentityKey(edge.scope, edge.from);
    const toKey = providerGraphIdentityKey(edge.scope, edge.to);
    const from = nodes.get(fromKey); const to = nodes.get(toKey);
    const reason = conflictEdges.has(key) || conflictNodes.has(fromKey) || conflictNodes.has(toKey)
      ? 'conflicting_endpoint' : !from || !to ? 'missing_endpoint'
        : from.operation === 'tombstone' || to.operation === 'tombstone' ? 'tombstoned_endpoint'
          : Date.parse(edge.sourceEventAt) < Date.parse(from.sourceEventAt) ? 'stale_association' : null;
    if (reason) unresolved.push({ association: edge, reason }); else resolved.push(edge);
  }
  const values = [...nodes.entries()].filter(([key]) => !conflictNodes.has(key)).map(([, row]) => row);
  return { nodes: values.filter((row) => row.operation === 'upsert'),
    tombstones: values.filter((row) => row.operation === 'tombstone'), resolved, unresolved,
    duplicates, stale, conflicts, refusedScope };
}
