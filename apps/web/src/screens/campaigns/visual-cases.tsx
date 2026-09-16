import { campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';
import { campaignCreationResult } from '../../campaigns/creation-result';
import { CAMPAIGN_UNAVAILABLE_COPY } from './unavailable';
import type { ReactNode } from 'react';
import type { ScreenState } from '../types';
import Loading from '../shared-loading';
import SharedError from '../shared-error';
import BuilderScreen from './view';
import { Builder } from './builder';
import { KEYWORD_SOURCES } from './targets';
import { CampaignPage } from './ui';
import DraftScreen, { DraftReady } from '../campaigns-draft/view';
import { BidEditor } from '../campaigns-draft/bid';
import { CreationConfirm, CreationResult, KeywordRetry } from '../campaigns-draft/creation-states';
import AssetsScreen from '../campaigns-assets/view';
import { AssetPicker } from '../campaigns-assets/picker';
import NamingScreen, { NamingReady } from '../campaigns-naming/view';
import EligibilityScreen from '../campaigns-eligibility/view';
import UpdateScreen from '../campaigns-update/view';
import { fixtureCpcRationale, fixtureNaming, fixtureReverseName, builderContext, builderRecipe, savedDraft, validatedDraft, blockedDraft, fixtureReview, validationChecks, measuredCreationChecks, creationBatchFixture, fixtureId, assetSnapshot, creationResult, ready } from './render-fixture';

export interface CampaignVisualCase { screen: string; key: string; state: ScreenState | 'ready'; text: string; render: () => ReactNode }
const noop = () => {};
const draftData = { view: 'ready' as const, context: builderContext, draft: savedDraft, review: fixtureReview, executorAvailable: false, step: 'review' };
const namingData = { view: 'ready' as const, profileId: fixtureId(2), naming: fixtureNaming, canEdit: true,
  profiles: [builderContext.profile, { id: fixtureId(12), label: 'Synthetic second account' }], presets: [{ id: fixtureId(7), name: 'Synthetic convention', naming: fixtureNaming, createdBy: fixtureId(4), usageCount: 1 }] };
const cases: CampaignVisualCase[] = [];
function add(screen: string, key: string, text: string, render: () => ReactNode, state: ScreenState | 'ready' = 'ready') { cases.push({ screen, key, text, render, state }); }
const unavailable = { available: false as const };
const available = { available: true as const, create: noop, retry: noop };
const builders = ['SP', 'SB', 'SBV', 'SD'] as const;
for (const adType of builders) add('campaigns', `products-${adType.toLowerCase()}`, 'Choose the ad type first', () => <CampaignPage title="Campaign Builder"><Builder context={builderContext} initialRecipe={{ ...builderRecipe, adType }} /></CampaignPage>);
for (const [source, label] of KEYWORD_SOURCES) add('campaigns', `targets-${source}`, label, () => <CampaignPage title="Campaign Builder"><Builder context={builderContext} initialRecipe={builderRecipe} initialStep="targets" initialSource={source} /></CampaignPage>);
add('campaigns', 'targets-keyword-set', 'the keyword set in each', () => <CampaignPage title="Campaign Builder"><Builder context={builderContext} initialRecipe={{ ...builderRecipe, structure: 'set-product' }} initialStep="targets" /></CampaignPage>);
add('campaigns', 'review', 'Review campaign draft', () => <CampaignPage title="Campaign Builder"><Builder context={builderContext} initialRecipe={builderRecipe} initialStep="review" /></CampaignPage>);
for (const [key, draft] of [['draft', savedDraft], ['validated', validatedDraft], ['blocked', blockedDraft]] as const) add('campaigns-draft', key, key === 'blocked' ? 'Fix draft issues' : 'Review campaign draft', () => <DraftReady data={{ ...draftData, draft }} />, key === 'blocked' ? 'blocked' : 'ready');
add('campaigns-draft', 'edit', 'Save draft', () => <DraftReady data={draftData} initiallyEditing />);
const bidProps = { keyword: builderRecipe.keywords[0]!, evidence: builderContext.bidEvidence[0]!, bounds: { floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }, currency: 'USD', topOfSearch: 140, audienceAdjustment: 0, onUse: noop, onCancel: noop };
add('campaigns-draft', 'bid-within-range', 'Allowed base bid', () => <BidEditor {...bidProps} />);
add('campaigns-draft', 'bid-exceeded', 'Top-of-search exposure exceeds the limit', () => <BidEditor {...bidProps} topOfSearch={700} />);
add('campaigns-draft', 'bid-manual', 'Enter bid manually', () => <BidEditor {...bidProps} evidence={null} />);
add('campaigns-draft', 'bid-calculation', 'Base bid formula', () => <BidEditor {...bidProps} expanded />);
add('campaigns-draft', 'bid-reconcile-warning', 'Source totals do not reconcile', () => <BidEditor {...bidProps} expanded keyword={{ ...bidProps.keyword, basis: 'keyword_cpc' }} evidence={{ ...bidProps.evidence, reportedCpc: 1.2 }} />);
add('campaigns-draft', 'bid-rationale', 'Source reconciled', () => <BidEditor {...bidProps} rationaleExpanded frozenRationale={fixtureCpcRationale} keyword={{ ...bidProps.keyword, basis: 'keyword_cpc' }} />);
add('campaigns-draft', 'bid-sqp-unmeasured', 'SQP value: not measured', () => <BidEditor {...bidProps} keyword={{ ...bidProps.keyword, basis: 'sqp_value' }} />);
add('campaigns-draft', 'validation', 'Fix draft issues', () => <DraftReady data={{ ...draftData, draft: blockedDraft, step: 'validation' }} />);
add('campaigns-draft', 'confirm-unavailable', 'Creation in Amazon is not available yet', () => <CreationConfirm marketplaceLabel={builderContext.profile.countryCode} review={fixtureReview} checks={validationChecks} executor={unavailable} onExport={noop} onBack={noop} />);
add('campaigns-draft', 'confirm-executor-fixture', 'Yes, create 1 campaign in Amazon', () => <CreationConfirm marketplaceLabel={builderContext.profile.countryCode} review={fixtureReview} checks={measuredCreationChecks} executor={available} onExport={noop} onBack={noop} />);
const staleReview = { ...fixtureReview, checkedAt: fixtureReview.plan.expiresAt };
add('campaigns-draft', 'confirm-stale', 'The current approval evidence is unavailable or stale', () => <CreationConfirm review={{ ...staleReview, freshness: campaignCreationReviewFreshness(staleReview) }} checks={measuredCreationChecks} executor={available} onExport={noop} onBack={noop} />, 'stale');
add('campaigns-draft', 'confirm-blocked', 'Review this draft again', () => <CreationConfirm review={fixtureReview} checks={blockedDraft.validation!.checks} executor={available} onExport={noop} onBack={noop} />);
add('campaigns-draft', 'in-progress', 'Campaign creation in progress', () => <CreationResult batch={creationBatchFixture('admitted')} result={campaignCreationResult(creationBatchFixture('admitted'))} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'batch-partial', 'Campaign partially created', () => <CreationResult batch={creationBatchFixture('partial')} result={campaignCreationResult(creationBatchFixture('partial'))} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'batch-complete', 'Campaign created', () => <CreationResult batch={creationBatchFixture('complete')} result={campaignCreationResult(creationBatchFixture('complete'))} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'batch-retry', 'Yes, retry 1 keyword in Amazon', () => <KeywordRetry plan={fixtureReview.plan} result={campaignCreationResult(creationBatchFixture('partial'))} executor={unavailable} onBack={noop} />);
add('campaigns-draft', 'confirm-not-measured-executor-fixture', 'Checks not measured', () => <CreationConfirm review={fixtureReview} checks={validationChecks} executor={available} onExport={noop} onBack={noop} />);
add('campaigns-draft', 'needs-attention', 'Campaign creation needs attention', () => <CreationResult batch={creationBatchFixture('uncertain')} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'ambiguous-readback', 'ambiguous_readback', () => <CreationResult batch={creationBatchFixture('ambiguous')} onRetry={noop} onBack={noop} />, 'refused');
add('campaigns-draft', 'resource-retry', 'Yes, retry 4 resources in Amazon', () => <KeywordRetry batch={creationBatchFixture('uncertain')} plan={fixtureReview.plan} executor={unavailable} onBack={noop} />);
add('campaigns-draft', 'adopted', 'Existing resources adopted 1', () => <CreationResult batch={creationBatchFixture('adopted')} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'partial', 'Campaign partially created', () => <CreationResult result={creationResult(false)} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'retry-unavailable', 'Yes, retry 1 keyword in Amazon', () => <KeywordRetry plan={fixtureReview.plan} result={creationResult(false)} executor={unavailable} onBack={noop} />);
add('campaigns-draft', 'retry-executor-fixture', 'Successful resources will not be created again', () => <KeywordRetry plan={fixtureReview.plan} result={creationResult(false)} executor={available} onBack={noop} />);
add('campaigns-draft', 'complete', '0 duplicated resources', () => <CreationResult result={creationResult(true)} onRetry={noop} onBack={noop} />);
add('campaigns-draft', 'result-not-recorded', 'No creation result has been recorded', () => <DraftReady data={{ ...draftData, step: 'result' }} />);
for (const tab of ['library', 'used', 'upload'] as const) add('campaigns-assets', tab, tab === 'used' ? 'Synthetic mirrored creative' : 'Pick a creative you already have', () => <CampaignPage title="Pick a creative you already have"><AssetPicker snapshot={assetSnapshot} used={[{ id: fixtureId(9), amazonAssetId: 'synthetic-asset', name: 'Synthetic mirrored creative', kind: 'sb_video', usedInCampaignIds: ['synthetic-campaign'] }]} canRefresh onRefresh={async () => {}} initialTab={tab} /></CampaignPage>);
add('campaigns-assets', 'no-snapshot', 'No asset-library snapshot exists yet', () => <CampaignPage title="Pick a creative you already have"><AssetPicker snapshot={null} used={[]} canRefresh onRefresh={async () => {}} /></CampaignPage>);
add('campaigns-assets', 'empty-snapshot', 'No assets match this snapshot', () => <CampaignPage title="Pick a creative you already have"><AssetPicker snapshot={{ ...assetSnapshot, sourceRows: 0, persistedRows: 0, assets: [] }} used={[]} canRefresh onRefresh={async () => {}} /></CampaignPage>);
add('campaigns-naming', 'preview-saved-copy', 'Copy to another profile', () => <NamingReady data={namingData} />);
const name = fixtureReverseName;
add('campaigns-naming', 'reverse-read', 'matches the Synthetic convention preset', () => <NamingReady data={namingData} initialName={name} initiallyRead />);
add('campaigns-naming', 'reverse-unparseable', 'does not match', () => <NamingReady data={namingData} initialName="unparseable" initiallyRead />);
add('campaigns-eligibility', 'nine-checks', 'yes', () => <EligibilityScreen data={ready} />);
add('campaigns-update', 'recipe', 'Update campaigns', () => <UpdateScreen data={{ view: 'ready', profileId: fixtureId(2), profileLabel: 'Synthetic account', marketplace: 'US' }} />);
const screens = {
  campaigns: BuilderScreen, 'campaigns-draft': DraftScreen, 'campaigns-assets': AssetsScreen,
  'campaigns-naming': NamingScreen, 'campaigns-eligibility': EligibilityScreen, 'campaigns-update': UpdateScreen,
};
for (const [screen, View] of Object.entries(screens)) {
  add(screen, 'loading', 'Loading this screen', () => <Loading />, 'loading');
  add(screen, 'error', 'synthetic-reference', () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={noop} />, 'error');
  for (const state of ['empty', 'gated', 'not-measured'] as const) add(screen, state, CAMPAIGN_UNAVAILABLE_COPY[screen as keyof typeof CAMPAIGN_UNAVAILABLE_COPY][state][0], () => <View data={{ view: state, message: CAMPAIGN_UNAVAILABLE_COPY[screen as keyof typeof CAMPAIGN_UNAVAILABLE_COPY][state][1] }} />, state);
}
add('campaigns-new', 'loading', 'Loading this screen', () => <Loading />, 'loading');
add('campaigns-new', 'error', 'synthetic-reference', () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={noop} />, 'error');
export const campaignVisualCases: readonly CampaignVisualCase[] = cases;
