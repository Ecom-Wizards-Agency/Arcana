// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { spCoordinatedCapabilities } from '@wizard-ads/core';
import { CalculationTrace, CoordinatedMethodInput } from '@wizard-ads/shared';
import Loading from '../../../app/optimizer/review/[batchId]/calculation/[rowId]/loading';
import { rendered, verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { ready as reviewReady, referenceRows, tracedReference } from '../optimizer-review/render-fixture';
import { workedPlacementInputs, workedPlacementRow } from '../optimizer-review/worked-example';
import { descriptor } from './descriptor';
import Screen from './view';

const ready = { ...reviewReady, props: { ...reviewReady.props, row: referenceRows[0]! } };
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders calculation loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders shared error evidence', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-calculation' })} reset={() => {}} />, text: 'synthetic-calculation' },
  { state: 'gated', name: 'explains unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'explains absent profiles', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'does not reconstruct missing calculation evidence', render: () => <Screen data={ready} />, text: 'Recorded calculation unavailable' },
  { state: 'ready', name: 'renders recorded trace steps', render: () => <Screen data={{ ...ready, props: { ...ready.props, row: tracedReference } }} />, text: 'Calculation steps' },
]);

const snapshot = CoordinatedMethodInput.parse({
  runId: workedPlacementRow.runId, profileId: workedPlacementRow.profileId,
  methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1',
  window: workedPlacementRow.inputs.window, admittedAt: '2026-07-30T00:00:00.000Z',
  methodParameters: { targetAcos: 0.36, caps: { maxIncrease: 0.47, maxDecrease: 0.58 },
    floors: { manualMinBid: 0.09 }, ceilings: { manualMaxBid: 0.91 }, exposureCeiling: 1.31,
    minClicksPerPlacement: 12, placementEvidenceRequirements: 'single_target' },
  resolvedSettings: {},
  evidenceRows: [{ entityRef: { profileId: workedPlacementRow.profileId, campaignId: workedPlacementRow.campaignId,
    entityId: workedPlacementRow.entityId, entityType: 'keyword', adProduct: 'SP' }, adProduct: 'SP',
    currentBid: workedPlacementRow.currentValue, metrics: { clicks: 72, sales: 144, orders: 9, cost: 49 },
    levels: { profile: { clicks: 72, sales: 144, orders: 9 } }, stock: { status: 'in_stock', asins: [] } }],
  campaignEvidence: { campaignId: workedPlacementRow.campaignId, costType: 'cpc', currentControls: null,
    targetCount: 1, complete: true, attributionMature: true, homogeneousProxyValidation: null,
    capabilities: spCoordinatedCapabilities(),
    placementFacts: workedPlacementInputs.map((input, index) => ({ campaignId: workedPlacementRow.campaignId,
      placement: ['top_of_search', 'rest_of_search', 'product_pages'][index],
      clicks: input.clicks, sales: input.revenue, clickShare: input.clickShare })),
  },
});
const rpcStep = { index: 0, label: 'RPC: top_of_search', formula: 'sales / clicks',
  inputs: [{ name: 'sales', value: 90, unit: 'USD' }, { name: 'clicks', value: 30, unit: 'clicks' }],
  intermediateValue: null, boundApplied: null, result: 3.125 };
// Deliberately differs from recomputed RPC: presentation must preserve the recorded result.
const recordedRow = { ...workedPlacementRow, inputs: { ...workedPlacementRow.inputs,
  trace: CalculationTrace.parse({ steps: [rpcStep], finalResult: 3.125, roundingStep: rpcStep }) } };
function savedCalculation(snapshots: CoordinatedMethodInput[]) {
  return { ...reviewReady, props: { ...reviewReady.props, row: recordedRow,
    review: { ...reviewReady.props.review, children: reviewReady.props.review.children.map((child) => ({ ...child, calculationSnapshots: snapshots })) } } };
}

it('projects all placement facts from the matching saved snapshot and preserves recorded RPC results', () => {
  const unrelated = { ...snapshot, campaignEvidence: { ...snapshot.campaignEvidence, campaignId: 'synthetic-other-campaign' } };
  const host = rendered(<Screen data={savedCalculation([unrelated, snapshot])} />);
  const rows = [...host.querySelectorAll('table[aria-label="Placement report inputs"] tbody tr')];
  expect(rows).toHaveLength(snapshot.campaignEvidence.placementFacts.length + 1);
  expect([...rows[0]!.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['Top of search', '30', '$90.00', '$3.13', '41.67%']);
  expect(rows[1]!.querySelectorAll('td')[3]!.textContent).toBe('Unavailable');
  expect(rows[2]!.querySelectorAll('td')[3]!.textContent).toBe('Unavailable');
  expect(rows[3]!.querySelectorAll('td')[1]!.textContent).toBe('72');
});

it.each([
  { name: 'absent', snapshots: [] },
  { name: 'ambiguous', snapshots: [snapshot, snapshot] },
  { name: 'different run', snapshots: [{ ...snapshot, runId: '11111111-1111-4111-8111-111111111111' }] },
  { name: 'different profile', snapshots: [{ ...snapshot, profileId: '11111111-1111-4111-8111-111111111111' }] },
  { name: 'mismatched campaign fact', snapshots: [{ ...snapshot, campaignEvidence: { ...snapshot.campaignEvidence,
    placementFacts: snapshot.campaignEvidence.placementFacts.map((fact) => ({ ...fact, campaignId: 'synthetic-other-campaign' })) } }] },
])('keeps $name saved placement evidence unavailable', ({ snapshots }) => {
  const host = rendered(<Screen data={savedCalculation(snapshots)} />);
  expect(host.querySelector('table[aria-label="Placement report inputs"]')).toBeNull();
  expect(host.textContent).toContain('Recorded placement report inputs are unavailable for this preview.');
});
