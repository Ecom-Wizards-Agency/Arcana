import { providerEvidenceSnapshot } from '@wizard-ads/core';
import type { ProviderEvidenceConsumer, ProviderEvidenceReadResult } from '@wizard-ads/shared';

/** Provider evidence has no selection, acceptance or execution controls. */
export function ProviderEvidencePanel({ evidence, consumer, now = new Date().toISOString() }: { evidence?: ProviderEvidenceReadResult | undefined; consumer: ProviderEvidenceConsumer; now?: string }) {
  const snapshot = providerEvidenceSnapshot(evidence ?? { rows: [], runs: [], totalCount: 0 }, consumer, now);
  return <section aria-label="Amazon provider evidence" className="wa-card" style={{ overflowWrap: 'anywhere' }}>
    <h2>Amazon provider evidence</h2>
    <p>Amazon recommendations and estimates · {snapshot.returnedCount} of {snapshot.totalCount} records</p>
    <ul>{snapshot.families.map((family) => <li key={family.family}>{family.family}: {family.availability} · {family.reason}
      {family.counts ? <span> · source {family.counts.source}, parsed {family.counts.parsed}, refused {family.counts.refused}, duplicates {family.counts.duplicates}, conflicts {family.counts.conflicts}, stored {family.counts.canonical}, written {family.counts.written}, existing {family.counts.existing}, verified {family.counts.readback}</span> : null}
    </li>)}</ul>
    {snapshot.rows.map(({ recommendation: r, availability, comparison }) => <article key={`${r.namespace}:${r.providerId}:${r.version}`} data-provider-evidence-row>
      <h3>{r.kind} · Amazon · {availability}</h3>
      <p>Profile {r.scope.profileId} · marketplace {r.scope.marketplaceId} · {r.family} · {r.apiVersion} · entity {r.entity.entityId ?? 'unresolved'} ({r.entity.mapping})</p>
      <p>Amazon current: {r.current.value ?? 'not supplied'} · Amazon proposed: {r.proposed.value ?? 'not supplied'} · Arcana: {comparison.arcana?.value ?? 'not comparable'} · {comparison.status}</p>
      <p>{comparison.reason} · eligibility: {r.eligibility} · units: {r.proposed.units ?? 'not supplied'} · currency: {r.proposed.currency ?? 'not supplied'} · horizon: {r.horizon ?? 'not supplied'}</p>
      <ul>{r.estimates.map((estimate, index) => <li key={index}>Amazon estimate: {estimate.metric} {estimate.value ?? 'not supplied'} {estimate.units ?? '(units not supplied)'} · range {estimate.low ?? 'not supplied'}–{estimate.high ?? 'not supplied'} · {estimate.horizon ?? 'horizon not supplied'} · {estimate.currency ?? 'currency not supplied'} · attribution {estimate.attribution ?? 'not supplied'}</li>)}</ul>
      <p>Generated: {r.generatedAt ?? 'not supplied'} · observed: {r.observedAt} · retrieved: {r.retrievedAt} · expires: {r.expiresAt ?? 'not supplied'}</p>
      <details><summary>Sanitized provider evidence</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(r.payload, null, 2)}</pre></details>
    </article>)}
    {snapshot.truncated ? <p>More provider evidence is available. Narrow the entity scope to review it.</p> : null}
  </section>;
}
