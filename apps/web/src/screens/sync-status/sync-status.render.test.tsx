import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { catalogueReady, ready } from './render-fixture';
import { StreamExtensionDataset } from '@wizard-ads/shared';
import { verifyScreen } from '../settings/render-support';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
// @vitest-environment jsdom
import Loading from '../../../app/sync-status/loading';
import SharedError from '../../../app/sync-status/error';
import Screen, { type ScreenData } from './view';
import type { ReportLaneErrorClass, ReportLaneStage, ReportLaneStageStatus } from '@wizard-ads/shared';

const quietStage = (stage: ReportLaneStage): ReportLaneStageStatus => ({
  stage, lastSucceededAt: '2026-09-24T07:34:00.000Z', lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0,
});
/** The production shape of 24 Sept: fetch blocked, 762 dead fetches re-requested, requests resolved. */
function blockedAt(stage: ReportLaneStage, errorClass: ReportLaneErrorClass): ScreenData {
  const stages = (['request', 'poll', 'fetch', 'load'] as const).map((name): ReportLaneStageStatus => name === stage
    ? { ...quietStage(name), lastSucceededAt: '2026-09-20T06:00:00.000Z', lastFailedAt: '2026-09-24T10:10:00.000Z', lastErrorClass: errorClass, dead: 762 }
    : quietStage(name));
  return { ...ready, props: { ...ready.props,
    status: { ...ready.props.status, freshness: [{ profileId: 'synthetic-profile', profileLabel: 'Synthetic profile', region: 'NA', syncEnabled: true, latestFactDate: '2026-08-28', queued: 297, running: 0, failed: 0 }] },
    lane: { scope: 'organisation', stages,
      blocking: { stage, errorClass, since: '2026-09-24T10:10:00.000Z', lastSucceededAt: '2026-09-20T06:00:00.000Z' },
      organisationDead: { total: 1874, byStage: { request: 1112, poll: 0, fetch: 762, load: 0 }, reRequested: 762, resolved: 1112 },
      profiles: [{ profileId: 'synthetic-profile', retrying: 3, dead: 1874 }] } } };
}

verifyScreen(descriptor, [
  { state: 'ready', name: 'shows the last Creator Connections import counters per kind, absent files as not measured', render: () => <Screen data={{ ...ready, props: { ...ready.props, creatorImport: {
    id: '33200000-0000-4000-8000-0000000000b1', startedAt: '2026-09-09T06:13:58.000Z', finishedAt: '2026-09-09T06:14:00.000Z', status: 'succeeded', failure: null, failedFile: null,
    files: ['registry', 'queue'], queueRunDate: '2026-09-09', source: 'control-runner', counts: { records: { read: 273, valid: 272, invalid: 1, inserted: 0, updated: 3, unchanged: 269, removed: 0 },
      action_log: { read: 4, valid: 4, invalid: 0, inserted: 1, updated: 0, unchanged: 3, removed: 0 }, queue_items: { read: 34, valid: 34, invalid: 0, inserted: 34, updated: 0, unchanged: 0, removed: 2 },
      sweep_runs: null, sample_shipments: null, preflights: null } } } }} />, text: 'Sweep runsNot measured: no file for it' },
  { state: 'ready', name: 'says a failed Creator Connections import wrote nothing', render: () => <Screen data={{ ...ready, props: { ...ready.props, creatorImport: {
    id: '33200000-0000-4000-8000-0000000000b2', startedAt: '2026-09-09T06:13:58.000Z', finishedAt: '2026-09-09T06:14:00.000Z', status: 'failed', failure: 'file_unreadable', failedFile: 'queue',
    files: ['queue'], queueRunDate: null, source: 'control-runner', counts: { records: null, action_log: null, queue_items: null, sweep_runs: null, sample_shipments: null, preflights: null } } } }} />, text: 'file_unreadable (queue). Nothing was written.' },
  { state: 'ready', name: 'never shows missing Creator Connections counters as zero', render: () => <Screen data={ready} />, text: 'Its counters are not measured' },
  { state: 'not-measured', name: 'distinguishes absent facts from a fresh zero', render: () => <Screen data={{ ...ready, props: { ...ready.props, status: { ...ready.props.status, freshness: [{ profileId: 'synthetic-profile', profileLabel: 'Synthetic profile', region: 'NA', syncEnabled: true, latestFactDate: null, queued: 0, running: 0, failed: 0 }] } } }} />, text: 'Facts not measured' },
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Sync status" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { result: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { result: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'shows the empty workspace', render: () => <Screen data={ready} />, text: "Sync status" },
  { state: 'ready', name: 'names the blocking fetch stage in the freshness banner', render: () => <Screen data={blockedAt('fetch', 'download_inflate_limit')} />, text: 'Reports are blocked at the fetch stage' },
  { state: 'ready', name: 'gives the blocking stage its last error class', render: () => <Screen data={blockedAt('fetch', 'download_inflate_limit')} />, text: 'Last error class: download_inflate_limit (The download exceeded the decompressed size limit)' },
  { state: 'ready', name: 'names a blocked request stage', render: () => <Screen data={blockedAt('request', 'create_outcome_unknown')} />, text: 'Reports are blocked at the request stage' },
  { state: 'ready', name: 'names a blocked poll stage', render: () => <Screen data={blockedAt('poll', 'provider_throttled')} />, text: 'Reports are blocked at the poll stage' },
  { state: 'ready', name: 'names a blocked load stage', render: () => <Screen data={blockedAt('load', 'load_failed')} />, text: 'Reports are blocked at the load stage' },
  { state: 'ready', name: 'labels organisation-wide dead jobs apart from per-profile counts', render: () => <Screen data={blockedAt('fetch', 'download_inflate_limit')} />, text: 'Dead report jobs across the organisation: 1874' },
  { state: 'ready', name: 'labels the per-profile retrying and dead columns', render: () => <Screen data={blockedAt('fetch', 'download_inflate_limit')} />, text: 'Retrying (this profile)Dead (this profile)' },
  { state: 'ready', name: 'says no stage is blocked when none is', render: () => <Screen data={ready} />, text: 'No report stage is blocked for every profile', absent: ['[data-testid="report-lane-blocking"]'] },
]);

it('renders four source scopes with nullable, empty, complete and failed cursor counts',()=>{
  render(<Screen data={catalogueReady}/>);
  const rows=screen.getAllByTestId('catalogue-source-row');expect(rows).toHaveLength(4);
  expect(rows[0]!.textContent).toContain('UnavailableUnavailableNot run');expect(rows[0]!.textContent).not.toContain('00');
  expect(rows[1]!.children[6]!.textContent).toBe('0');expect(rows[1]!.children[7]!.textContent).toBe('0');
  expect(rows[2]!.children[7]!.textContent).toBe('3');expect(rows[3]!.textContent).toContain('Synthetic cursor failure');
});

it('renders eight disabled bindings without inventing rejection or dead-letter counts', () => {
  const streams = StreamExtensionDataset.options.map((datasetId) => ({ datasetId, bindingCount: 0, enabled: false, confirmed: false,
    stored: 0, latestEventAt: null, maximumLagSeconds: null, duplicates: null, rejected: null, deadLettered: null }));
  render(<Screen data={{ ...ready, props: { ...ready.props, status: { ...ready.props.status, streams } } }} />);
  expect(screen.getAllByTestId('stream-extension-row')).toHaveLength(8);
  expect(screen.getAllByText('missing confirmation')).toHaveLength(8);
  expect(screen.getAllByText('unmeasured / unmeasured / unmeasured')).toHaveLength(8);
});

it('shows the market signals import totals and data-as-of only once the import has run', () => {
  const before = render(<Screen data={ready} />).container;
  expect(before.querySelectorAll('[data-testid="market-signals-import-row"]')).toHaveLength(0);
  expect(before.textContent).toContain('The wizards-ai market signals import has not run');
  const after = render(<Screen data={{ view: 'ready', props: { ...ready.props, marketSignals: {
    files: 2, batchesImported: 3, observations: 20, changePoints: 24, signals: 5, tagMarks: 30,
    invalidRecords: 1, unmappedSignals: 2, dataAsOf: '2026-09-25T01:00:00.000Z', lastImportedAt: null,
  } } }} />).container;
  const cells = [...after.querySelectorAll('[data-testid="market-signals-import-row"] td')].map((cell) => cell.textContent);
  expect(cells).toHaveLength(10);
  expect(cells.slice(1)).toEqual(['Not reported', '2', '3', '20', '24', '5', '30', '1', '2']);
  expect(cells[0]).toContain('01:00 UTC');
});
