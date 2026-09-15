import type { readOptimizerReview } from '@wizard-ads/db';
import { money } from './presentation';
import { DataTable, Cell } from './components';

type Review = NonNullable<Awaited<ReturnType<typeof readOptimizerReview>>>;
export function RunDetails({ review, currencyCode, marketplace }: { review: Review; currencyCode: string; marketplace: string }) {
  const snapshot = review.executionSnapshot;
  const settings = snapshot?.configuration;
  const calculations = review.children.flatMap((child) => child.calculationSnapshots);
  const admissions = review.children.flatMap((child) => child.methodAdmission ? [child.methodAdmission] : []);
  const maturity = calculations.flatMap((calculation) => calculation.methodId === 'sp.coordinated-efficiency'
    ? [`${calculation.campaignEvidence.campaignId}: ${calculation.campaignEvidence.attributionMature ? 'Mature' : 'Pending attribution'}`] : []);
  const rows: Array<[string, string, string]> = [
    ['Method', snapshot?.methodId ?? settings?.method ?? 'Unavailable', 'Immutable request'],
    ['Target ACOS', settings ? `${settings.targetAcos * 100}% run field; group values below take precedence` : 'Unavailable', 'Run field'],
    ['Bid limits', settings ? `${money(settings.bidFloor, currencyCode)}–${money(settings.bidCeiling, currencyCode)}; +${settings.bidIncreaseCap * 100}% / −${settings.bidDecreaseCap * 100}%` : 'Unavailable', 'Run fields; resolved sources below'],
    ['Report window', settings ? `${settings.window.start} to ${settings.window.end}` : 'Unavailable', 'Immutable request'],
    ['Snapshot', snapshot?.admittedAt ?? 'Unavailable', 'Admission time'],
    ['Requested calendar days', settings ? String((Date.parse(settings.window.end) - Date.parse(settings.window.start)) / 86400000 + 1) : 'Unavailable', 'Immutable requested reporting window'],
    ['Completed report days', 'Unavailable', 'Per-day completed reporting coverage was not recorded in this snapshot'],
    ['Currency', currencyCode, 'Current profile metadata; not recorded in the run snapshot'], ['Marketplace', marketplace, 'Current profile metadata; not recorded in the run snapshot'],
    ['Attribution maturity', maturity.join(' · ') || 'Unavailable', 'Saved calculation evidence'],
    ['Report generation time', 'Unavailable', 'Not recorded in this snapshot'],
    ['Entity state', 'Recorded in each calculation snapshot when available', 'Saved calculation evidence'],
    ['Cost type', calculations.map((calculation) => calculation.methodId === 'sp.coordinated-efficiency' ? calculation.campaignEvidence.costType.toUpperCase() : 'CPC').join(' · ') || 'Unavailable', 'Saved calculation evidence'],
    ['Group version', review.children.map((child) => child.run.groupSnapshot ? ('version' in child.run.groupSnapshot ? String(child.run.groupSnapshot.version) : 'Legacy v1') : 'Unassigned').join(' · '), 'Admission snapshot'],
    ['Method versions', [...new Set([...review.proposals.map((row) => `${row.inputs.methodId ?? 'Unavailable'} · ${row.inputs.methodVersion ?? 'Unavailable'}`), ...admissions.map((admission) => `${admission.methodId} · ${admission.methodVersion}`)])].join(' · ') || 'Unavailable', 'Saved proposals and admission'],
    ['Experiment locks', admissions.length ? admissions.flatMap((admission) => admission.experiments.map((experiment) => `${experiment.id} · ${experiment.status}`)).join(' · ') || 'No experiments in the admission snapshot' : 'Unavailable', 'Immutable admission checks'],
    ['Reconciliation counts', `${review.integrity.loadedCampaigns} / ${review.integrity.expectedCampaigns} campaigns; ${review.integrity.loadedChildren} / ${review.integrity.expectedChildren} runs; ${review.proposals.length} proposals`, 'Saved population'],
    ['Excluded days', 'Unavailable', 'Not recorded in this snapshot'], ['Pending attribution', 'Unavailable', 'Not recorded in this snapshot'],
  ];
  return <section><h2>Run details</h2><DataTable headers={['Setting', 'Effective value', 'Source']}>{rows.map(([key, value, source]) => <tr key={key}><Cell>{key}</Cell><Cell>{value}</Cell><Cell>{source}</Cell></tr>)}</DataTable>
    {review.children.map((child) => <details key={child.run.id}><summary>{child.run.groupSnapshot?.name ?? 'Unassigned campaigns'} · {child.campaignIds.length} campaigns</summary><p>{child.campaignIds.join(' · ')}</p>{child.run.groupSnapshot ? <p>Target ACOS {child.run.groupSnapshot.targetAcos * 100}% · assigned group</p> : null}<p>Requested run-field target ACOS: {settings ? `${settings.targetAcos * 100}%` : 'Unavailable'}. Assigned group values take precedence.</p><p>Requested reporting window: {settings ? `${settings.window.start} to ${settings.window.end}` : 'Unavailable'} · Timezone: {snapshot?.profileTimezone ?? 'Unavailable'}</p>{child.calculationSnapshots.map((calculation, index) => <details key={index}><summary>Recorded calculation snapshot {index + 1}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(calculation, null, 2)}</pre></details>)}</details>)}
    <p>This preview keeps its settings. Changing settings creates a new preview. It does not change an existing approval.</p><a href={`/settings/strategy?profile=${review.profileId}`}>Methods and release states</a> · <a href={`/optimizer/help?profile=${review.profileId}`}>How calculations work</a>
    {calculations.map((calculation, index) => <section key={index}><h3>Effective settings · {calculation.methodId} · {calculation.methodVersion}</h3><DataTable headers={['Setting', 'Effective value', 'Source']}>{Object.entries(calculation.resolvedSettings).map(([key, resolved]) => <tr key={key}><Cell>{key}</Cell><Cell>{['bidFloor', 'bidCeiling', 'exposureCeiling', 'manualMaxBid'].includes(key) ? money(resolved.value, currencyCode) : resolved.value === null ? 'Unavailable' : String(resolved.value)}</Cell><Cell>{resolved.sourceLabel} · {resolved.source}</Cell></tr>)}</DataTable></section>)}
  </section>;
}
