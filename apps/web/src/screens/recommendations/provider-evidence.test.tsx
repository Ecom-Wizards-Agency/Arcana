// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ProviderEvidenceConsumer } from '@wizard-ads/shared';
import { rendered } from '../render-test-support';
import RecommendationScreen from './view';
import { ready as recommendationReady } from './render-fixture';
import QueryScreen from '../query-intelligence/view';
import { ready as queryReady } from '../query-intelligence/render-fixture';
import CreativeScreen from '../creative/view';
import { ready as creativeReady } from '../creative/render-fixture';
import TargetScreen from '../targets/view';
import { targetFixture } from '../targets/fixtures';
import SyncScreen from '../sync-status/view';
import { ready as syncReady } from '../sync-status/render-fixture';
import type { ProviderEvidenceReadResult } from '@wizard-ads/shared';
import { ProviderEvidencePanel } from './provider-evidence';
import { at, id, row } from './provider-evidence.fixture';
it.each(['recommendations','targets','query-intelligence','creative','home','market-position','sync-status'] satisfies ProviderEvidenceConsumer[])('shows unmeasured source availability in the %s reader', (consumer) => {
  const html = renderToStaticMarkup(<ProviderEvidencePanel consumer={consumer} now={at} />);
  expect(html).toContain('Amazon provider evidence'); expect(html).toContain('not-measured'); expect(html).toContain('0 of 0 records'); expect(html).not.toContain('<button');
});
it.each(['measured','stale','expired'] as const)('renders %s provider estimates and counted rows separately from Arcana authority', (state) => {
  const recommendation = { ...row, expiresAt: state === 'expired' ? at : null };
  const html = renderToStaticMarkup(<ProviderEvidencePanel consumer="recommendations" evidence={{ rows: [recommendation], runs: [], totalCount: 1, arcana: [{ ...row, proposed: { ...row.proposed, value: 11 } }] }} now={state === 'stale' ? '2026-06-05T00:00:00.000Z' : at} />);
  expect(html).toContain(state); expect(html).toContain('Amazon estimate: clicks 0'); expect(html).toContain('Arcana: 11'); expect(html).toContain('not-comparable');
  expect(html.match(/data-provider-evidence-row/g)).toHaveLength(1); expect(html).not.toContain('<button'); expect(html).not.toContain('Apply');
});

for (const state of ['not-measured','measured','stale','expired'] as const) {
  it.each(['recommendations','targets','query-intelligence','creative','sync-status'] as const)(`renders ${state} evidence through the actual %s screen`, (consumer) => {
    const now = new Date().toISOString();
    const observed = state === 'stale' ? '2020-01-01T00:00:00.000Z' : now;
    const family = consumer === 'targets' ? 'sp-bid' : consumer === 'query-intelligence' ? 'sp-research' : consumer === 'creative' ? 'sb-recommendations' : 'tactical';
    const evidence: ProviderEvidenceReadResult = { rows: state === 'not-measured' ? [] : [{ ...row, family, observedAt: observed, generatedAt: observed, retrievedAt: now, expiresAt: state === 'expired' ? '2020-01-01T00:00:00.000Z' : null }], runs: [], totalCount: state === 'not-measured' ? 0 : 1 };
    const view = consumer === 'recommendations' ? <RecommendationScreen data={{ ...recommendationReady, props: { ...recommendationReady.props, providerEvidence: evidence } }} /> :
      consumer === 'query-intelligence' ? <QueryScreen data={{ ...queryReady, props: { ...queryReady.props, providerEvidence: evidence } }} /> :
      consumer === 'creative' ? <CreativeScreen data={{ ...creativeReady, props: { ...creativeReady.props, providerEvidence: evidence } }} /> :
      consumer === 'targets' ? <TargetScreen data={{ ...targetFixture, view: 'ready', currencyCode: 'USD', back: '/grid', savedView: null, providerEvidence: evidence }} /> :
      <SyncScreen data={{ ...syncReady, props: { ...syncReady.props, providerEvidence: [{ profileId: id, evidence }] } }} />;
    const host = rendered(view); const panel = host.querySelector('[aria-label="Amazon provider evidence"]');
    expect(panel).not.toBeNull(); expect(panel!.textContent).toContain(state);
    expect(panel!.querySelectorAll('[data-provider-evidence-row]')).toHaveLength(evidence.totalCount);
    expect(panel!.querySelectorAll('button')).toHaveLength(0);
    if (evidence.totalCount) expect(panel!.textContent).toContain('Amazon estimate');
  });
}
