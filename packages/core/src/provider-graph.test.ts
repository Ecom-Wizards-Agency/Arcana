import { describe, expect, it } from 'vitest';
import type { ProviderGraphAssociation, ProviderGraphObservation } from '@wizard-ads/shared';
import { compareProviderGraphEvidence, reconcileProviderGraph } from './provider-graph.js';

const scope = { orgId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002', amazonProfileId: 'synthetic', region: 'NA' as const };
const ad: ProviderGraphObservation = { scope, identity: { adProduct: 'SD', kind: 'ad', providerId: 'ad-one', version: null },
  source: 'marketing_stream', contractVersion: 'v1', sourceEventAt: '2026-09-01T00:00:00Z',
  observedAt: '2026-09-02T00:00:00Z', revision: '2', payloadFingerprint: 'a'.repeat(64), operation: 'upsert', state: 'enabled' };
const parent: ProviderGraphObservation = { ...ad, identity: { ...ad.identity, kind: 'ad_group', providerId: 'group-one' } };
const edge: ProviderGraphAssociation = { scope, from: ad.identity, to: parent.identity, relation: 'parent',
  sourceEventAt: ad.sourceEventAt, revision: '2', payloadFingerprint: ad.payloadFingerprint, operation: 'upsert' };
describe('provider graph reconciliation', () => {
  it('retains missing parents and resolves only after same-scope endpoint evidence arrives', () => {
    const first = reconcileProviderGraph({ scope, observations: [ad], associations: [edge] });
    expect(first.unresolved).toEqual([{ association: edge, reason: 'missing_endpoint' }]);
    const later = reconcileProviderGraph({ scope, observations: [...first.nodes, parent], associations: [edge] });
    expect(later.nodes).toHaveLength(2); expect(later.resolved).toEqual([edge]); expect(later.unresolved).toEqual([]);
  });
  it('never fabricates missing inventory or renews a replay observation', () => {
    const result = reconcileProviderGraph({ scope, observations: [ad, parent, { ...ad, observedAt: '2026-09-15T00:00:00Z' }], associations: [edge] });
    expect(result.nodes).toHaveLength(2); expect(result.duplicates).toBe(1);
    expect(result.nodes.find((n) => n.identity.kind === 'ad')?.observedAt).toBe(ad.observedAt);
  });
  it('refuses another tenant and product endpoint and retains unresolved edges', () => {
    const result = reconcileProviderGraph({ scope, observations: [ad,
      { ...parent, scope: { ...scope, profileId: '00000000-0000-4000-8000-000000000003' } },
      { ...parent, identity: { ...parent.identity, adProduct: 'SB' } }], associations: [edge] });
    expect(result.refusedScope).toBe(1); expect(result.resolved).toEqual([]); expect(result.unresolved).toHaveLength(1);
  });
  it('rejects stale revisions and quarantines equal-revision conflicts', () => {
    expect(compareProviderGraphEvidence({ ...ad, revision: '1' }, ad)).toBe('older');
    const result = reconcileProviderGraph({ scope, observations: [ad, parent,
      { ...ad, revision: '1' }, { ...ad, payloadFingerprint: 'b'.repeat(64) }], associations: [edge] });
    expect(result.stale).toBe(1); expect(result.conflicts).toBe(1); expect(result.resolved).toEqual([]);
    expect(result.unresolved[0]?.reason).toBe('conflicting_endpoint');
  });
  it('uses explicit tombstones and ignores stale edge restoration', () => {
    const removed = { ...edge, revision: '3', operation: 'tombstone' as const };
    const result = reconcileProviderGraph({ scope, observations: [ad, parent], associations: [edge, removed, edge] });
    expect(result.nodes).toHaveLength(2); expect(result.resolved).toEqual([]); expect(result.stale).toBe(1);
    const missing = reconcileProviderGraph({ scope, observations: [ad, parent, { ...parent, revision: '3', operation: 'tombstone' }], associations: [edge] });
    expect(missing.tombstones).toHaveLength(1); expect(missing.unresolved[0]?.reason).toBe('tombstoned_endpoint');
  });
});
