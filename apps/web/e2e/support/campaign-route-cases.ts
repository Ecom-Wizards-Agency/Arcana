import { CAMPAIGN_UNAVAILABLE_COPY } from '../../src/screens/campaigns/unavailable';
/** Data-only fixture manifest. Routes render their own registered screen views. */
import { randomUUID, createHash } from 'node:crypto';
import { serializeCampaignCreationPlanFingerprint } from '@wizard-ads/shared';
import { campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';
import { fixtureCpcRationale, fixtureNaming, builderContext, builderRecipe, savedDraft, validatedDraft, blockedDraft, fixtureReview, fixtureId, assetSnapshot, creationResult } from '../../src/screens/campaigns/render-fixture';
import type { E2EState } from './fixture';
import { USERS } from './fixture';
export interface CampaignRouteCase {
  id: string; screen: string; key: string; path: string; step?: string;
  mode: 'data' | 'loading' | 'error'; payload: unknown; expected: string;
  action?: 'edit' | 'rationale' | 'calculation' | 'reverse-read' | 'reverse-unparseable' | 'used' | 'keyword-set';
}
export function campaignRouteCases(fixture: E2EState, profileLabel = builderContext.profile.label): CampaignRouteCase[] {
  const context = { ...builderContext, profile: { ...builderContext.profile, id: fixture.fixtureProfileId, label: profileLabel } };
  const recipe = builderRecipe;
  function scopedDraft(source: typeof savedDraft, current = false) {
    const plan = { ...(current ? fixtureReview.plan : source.plan), orgId: fixture.orgId, profileId: fixture.fixtureProfileId };
    plan.fingerprint = createHash('sha256').update(serializeCampaignCreationPlanFingerprint(plan)).digest('hex');
    return { ...source, id: randomUUID(), orgId: fixture.orgId, profileId: fixture.fixtureProfileId, createdBy: USERS.admin, plan,
      validation: source.validation ? { ...source.validation, planFingerprint: plan.fingerprint } : null };
  }
  const draft = scopedDraft(savedDraft); const validated = scopedDraft(validatedDraft, true); const blocked = scopedDraft(blockedDraft);
  const reviewInput = { ...fixtureReview, plan: validated.plan, profile: { ...fixtureReview.profile, id: fixture.fixtureProfileId, label: profileLabel }, current: { ...fixtureReview.current, orgId: fixture.orgId, profileId: fixture.fixtureProfileId, planFingerprint: validated.plan.fingerprint } };
  const review = { ...reviewInput, freshness: campaignCreationReviewFreshness(reviewInput) };
  const draftData = { view: 'ready', context, draft, review, executorAvailable: false, step: 'review' };
  const namingData = { view: 'ready', profileId: fixture.fixtureProfileId, naming: fixtureNaming, canEdit: true,
    profiles: [context.profile, { id: fixtureId(12), label: 'Synthetic second account' }], presets: [{ id: fixtureId(7), name: 'Synthetic convention', naming: fixtureNaming, createdBy: USERS.admin, usageCount: 1 }] };
  const assetsData = { view: 'ready', profileId: fixture.fixtureProfileId, snapshot: { ...assetSnapshot, profileId: fixture.fixtureProfileId }, used: [{ id: fixtureId(9), amazonAssetId: 'synthetic-asset', name: 'Synthetic mirrored creative', kind: 'sb_video', usedInCampaignIds: ['synthetic-campaign'] }], canRefresh: true };
  const cases: CampaignRouteCase[] = [];
  function add(screen: string, key: string, payload: unknown, expected: string, action?: CampaignRouteCase['action'], step?: string, mode: CampaignRouteCase['mode'] = 'data') {
    cases.push({ id: randomUUID(), screen, key, payload, expected, mode, ...(action ? { action } : {}), ...(step ? { step } : {}), path: screen === 'campaigns' ? '/campaigns' : `/campaigns/${screen.replace('campaigns-', '')}` });
  }
  for (const adType of ['SP', 'SB', 'SBV', 'SD']) add('campaigns', `products-${adType.toLowerCase()}`, { view: 'ready', context, step: 'products', initialRecipe: { ...recipe, adType } }, 'Choose the ad type first');
  for (const [source, label] of [['paste', 'Paste'], ['search-terms', 'From search terms'], ['ngrams', 'From n-grams'], ['rank-radar', 'From Rank Radar'], ['saved', 'Saved keyword set']]) add('campaigns', `targets-${source}`, { view: 'ready', context, step: 'targets', initialRecipe: recipe, initialSource: source }, label!, undefined, 'targets');
  add('campaigns', 'targets-keyword-set', { view: 'ready', context, step: 'targets', initialRecipe: recipe }, 'the keyword set in each', 'keyword-set', 'targets');
  add('campaigns', 'review', { view: 'ready', context, step: 'review', initialRecipe: recipe }, 'Review campaign draft', undefined, 'review');
  for (const [key, value] of [['draft', draft], ['validated', validated], ['blocked', blocked]] as const) add('campaigns-draft', key, { ...draftData, draft: value }, key === 'blocked' ? 'Fix draft issues' : 'Review campaign draft', undefined, 'review');
  add('campaigns-draft', 'edit', draftData, 'Save draft', 'edit', 'review');
  for (const key of ['within-range', 'exceeded', 'manual', 'calculation', 'reconcile-warning', 'rationale', 'sqp-unmeasured']) {
    const nextContext = { ...context, bidEvidence: key === 'manual' ? [] : context.bidEvidence.map((evidence) => ({ ...evidence, reportedCpc: key === 'reconcile-warning' ? 1.2 : evidence.reportedCpc })) };
    const basis = key === 'sqp-unmeasured' ? 'sqp_value' : ['rationale', 'reconcile-warning'].includes(key) ? 'keyword_cpc' : 'manual';
    const nextDraft = { ...draft, ...(key === 'rationale' ? { rationale: draft.rationale.map((item) => ({ ...item, sentence: fixtureCpcRationale })) } : {}), recipe: { ...recipe, topOfSearch: key === 'exceeded' ? 700 : recipe.topOfSearch, keywords: recipe.keywords.map((keyword) => ({ ...keyword, basis })) } };
    add('campaigns-draft', `bid-${key}`, { ...draftData, context: nextContext, draft: nextDraft, step: 'bid' }, key === 'exceeded' ? 'Top-of-search exposure exceeds the limit' : key === 'reconcile-warning' ? 'Source totals do not reconcile' : key === 'rationale' ? 'Source reconciled' : key === 'sqp-unmeasured' ? 'SQP value: not measured' : 'Allowed base bid', key === 'rationale' ? 'rationale' : ['calculation', 'reconcile-warning'].includes(key) ? 'calculation' : undefined, 'bid');
  }
  add('campaigns-draft', 'validation', { ...draftData, draft: blocked, step: 'validation' }, 'Fix draft issues', undefined, 'validation');
  for (const available of [false, true]) add('campaigns-draft', available ? 'confirm-executor-fixture' : 'confirm-unavailable', { ...draftData, draft: validated, review, step: 'confirm', executorAvailable: available, ...(available ? { fixtureExecutor: 'inert' } : {}) }, 'Yes, create 1 campaign in Amazon', undefined, 'confirm');
  add('campaigns-draft', 'partial', { ...draftData, step: 'result', result: creationResult(false) }, 'Campaign partially created', undefined, 'result');
  for (const available of [false, true]) add('campaigns-draft', available ? 'retry-executor-fixture' : 'retry-unavailable', { ...draftData, step: 'retry', result: creationResult(false), ...(available ? { fixtureExecutor: 'inert' } : {}) }, 'Yes, retry 1 keyword in Amazon', undefined, 'retry');
  add('campaigns-draft', 'complete', { ...draftData, step: 'result', result: creationResult(true) }, '0 duplicated resources', undefined, 'result');
  add('campaigns-draft', 'result-not-recorded', { ...draftData, step: 'result' }, 'No creation result has been recorded', undefined, 'result');
  for (const tab of ['library', 'used', 'upload']) add('campaigns-assets', tab, { ...assetsData, initialTab: tab === 'upload' ? 'upload' : 'library' }, tab === 'used' ? 'Synthetic mirrored creative' : 'Pick a creative you already have', tab === 'used' ? 'used' : undefined);
  add('campaigns-assets', 'no-snapshot', { ...assetsData, snapshot: null }, 'No asset-library snapshot exists yet');
  add('campaigns-assets', 'empty-snapshot', { ...assetsData, snapshot: { ...assetsData.snapshot, assets: [], sourceRows: 0, persistedRows: 0 } }, 'No assets match this snapshot');
  add('campaigns-naming', 'preview-saved-copy', namingData, 'Copy to another profile');
  add('campaigns-naming', 'reverse-read', namingData, 'matches the Synthetic convention preset', 'reverse-read');
  add('campaigns-naming', 'reverse-unparseable', namingData, 'does not match', 'reverse-unparseable');
  add('campaigns-eligibility', 'nine-checks', { view: 'ready', context, step: 'products' }, 'A check we cannot run is shown as unavailable, never as passed.');
  add('campaigns-update', 'recipe', { view: 'ready', profileId: fixture.fixtureProfileId, profileLabel: context.profile.label, marketplace: 'US' }, 'Update campaigns');
  for (const screen of ['campaigns', 'campaigns-draft', 'campaigns-assets', 'campaigns-naming', 'campaigns-eligibility', 'campaigns-update', 'campaigns-new']) {
    add(screen, 'loading', { view: 'empty', message: 'Loading fixture completed.' }, 'Loading this screen', undefined, undefined, 'loading');
    add(screen, 'error', { view: 'error', message: 'Synthetic campaign route failure' }, 'Something failed on our side', undefined, undefined, 'error');
    if (screen === 'campaigns-new') continue;
    for (const state of ['empty', 'gated', 'not-measured'] as const) { const copy = CAMPAIGN_UNAVAILABLE_COPY[screen as keyof typeof CAMPAIGN_UNAVAILABLE_COPY][state]; add(screen, state, { view: state, message: copy[1] }, copy[0]); }
  }
  return cases;
}
