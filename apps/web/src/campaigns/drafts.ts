import { createHash, randomUUID } from 'node:crypto';
import { buildCampaignRecipe, campaignRecipeCreationPlan, creationPlanToBulkWorkbook, namingSettingsFromStrategy, parseCampaignName } from '@wizard-ads/campaigns';
import { calculateCampaignStartingBid, campaignBidRationale, campaignBuilderEligibility } from '@wizard-ads/core';
import { readCampaignDraft, saveCampaignDraft, recordCampaignDraftValidation, CampaignDraftConflict, type AuthenticatedEditorTransaction, type AuthenticatedReadSnapshot } from '@wizard-ads/db';
import { CampaignBuilderRecipe, type CampaignBuilderContext, type CampaignDraft, type CampaignBuilderCheck } from '@wizard-ads/shared';
import { loadCampaignBuilderContext } from './data';
import { builderBidEvidence, builderBounds } from './model';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function validateBuilderDraft(draft: CampaignDraft, context: CampaignBuilderContext, names: string[], now: string) {
  const campaignNames = draft.plan.nodes.flatMap((node) => node.kind === 'campaign.create' ? [node.payload.name] : []);
  const parsedNames = context.naming === null ? [] : campaignNames.map((name) => ({ name, naming: context.naming!,
    confidence: parseCampaignName(name, namingSettingsFromStrategy(context.naming!)).confidence }));
  const checks = campaignBuilderEligibility({ plan: draft.plan, budget: context.budget, existingNames: names,
    naming: context.naming, parsedNames, bounds: builderBounds(context, draft.recipe.groupId),
    audienceAdjustment: draft.recipe.audienceAdjustment, capabilities: context.capabilities });
  const unverified = draft.recipe.keywords.filter((keyword) => !calculateCampaignStartingBid({ basis: keyword.basis, manualBid: keyword.bid,
    evidence: builderBidEvidence(context, keyword.text), bounds: builderBounds(context, draft.recipe.groupId),
    topOfSearch: draft.recipe.topOfSearch, audienceAdjustment: draft.recipe.audienceAdjustment }).usable);
  const exposure = checks.find((check) => check.id === 'exposure');
  if (exposure && unverified.length && !exposure.blocking) Object.assign(exposure, { status: 'blocked', blocking: true,
    label: 'Starting bid basis requires verification', currentValue: unverified.map((keyword) => `${keyword.text} · ${keyword.basis} · ${context.profile.currencyCode} ${keyword.bid}`).join('; '), requiredAction: 'Verify the bid source or select a manual bid and review its exposure.' });
  const additional = (id: CampaignBuilderCheck['id'], label: string, failure: string, pass: boolean, source: string, currentValue: string, requiredAction: string): CampaignBuilderCheck => ({ id, label: pass ? label : failure, source,
    status: pass ? 'passed' : 'blocked', blocking: !pass, currentValue, requiredAction: pass ? '' : requiredAction });
  const productNodes = draft.plan.nodes.filter((node) => node.kind === 'eligibility.require_product');
  const productsPresent = draft.recipe.productKeys.every((key) => context.products.some((product) => product.key === key)) && productNodes.every((node) => context.products.some((product) => product.asin === node.payload.asin && product.sku === node.payload.sku));
  const expectedCampaigns = draft.recipe.productKeys.length * (draft.recipe.structure === 'keyword-product' ? draft.recipe.keywords.length : 1);
  const expectedKeywords = draft.recipe.productKeys.length * draft.recipe.keywords.length;
  const groupMatches = context.groups.some((group) => group.id === draft.recipe.groupId && group.role === draft.recipe.play);
  const countMatches = groupMatches && draft.plan.counts.byKind['campaign.create'] === expectedCampaigns && draft.plan.counts.byKind['target.create'] === expectedKeywords
    && draft.plan.nodes.filter((node) => node.kind === 'target.create').every((node) => { const target = node.payload; return target.targetType === 'keyword' && draft.recipe.keywords.some((keyword) => keyword.text === target.text && keyword.bid === target.bid); });
  checks.push(additional('product', 'Selected products are in the advertised-product mirror', 'Selected products are missing or changed in the mirror', productsPresent, 'Advertised-product mirror', draft.recipe.productKeys.join(', '), 'Sync the products and select an advertised product with the same ASIN and SKU.'),
    additional('permission', 'Operator can edit this profile', 'Operator lacks permission to edit this profile', context.canEdit, 'Current organization membership', context.canEdit ? 'Editing permission confirmed' : 'Editing permission unavailable', 'Ask an organization owner or administrator for editing access to this profile.'),
    additional('count', 'Requested resource count and optimization group match the saved draft', 'Resource counts, keyword bids or optimization group do not match', countMatches, 'Saved draft', `${draft.plan.counts.byKind['campaign.create']} campaign resources · ${draft.plan.counts.byKind['target.create']} keyword resources · Group ${groupMatches ? 'matches' : 'does not match'}`, `Rebuild this exact draft with ${expectedCampaigns} campaign resources and ${expectedKeywords} keyword resources, the selected bids and a ${draft.recipe.play} optimization group.`));
  return { planFingerprint: draft.plan.fingerprint, recipeFingerprint: digest(JSON.stringify(draft.recipe)), checkedAt: now, checks };
}
export async function validateSavedBuilderDraft(context: AuthenticatedEditorTransaction, profileId: string, id: string, expectedRevision: number): Promise<CampaignDraft> {
  const draft = await readCampaignDraft(context, profileId, id);
  if (!draft || draft.revision !== expectedRevision) throw new CampaignDraftConflict();
  const source = await loadCampaignBuilderContext(context, profileId);
  const names = await context.sql<{ name: string }[]>`select name from public.campaigns where org_id=${context.actor.orgId}::uuid and profile_id=${profileId}::uuid`;
  return recordCampaignDraftValidation(context, draft, validateBuilderDraft(draft, source, names.map((row) => row.name), new Date().toISOString()));
}
export async function saveBuilderDraft(context: AuthenticatedEditorTransaction, input: { profileId: string; id: string; expectedRevision: number | null; recipe: unknown; validate: boolean }): Promise<CampaignDraft> {
  const recipe = CampaignBuilderRecipe.parse(input.recipe);
  const source = await loadCampaignBuilderContext(context, input.profileId);
  if (!source.canEdit || !source.profile.marketplace) throw new Error('Profile rules or editing permission unavailable');
  const now = new Date().toISOString();
  const bulk = buildCampaignRecipe(recipe, source);
  recipe.names = Object.fromEntries(bulk.campaigns.map((campaign, index) => [String(index), campaign.name]));
  const plan = campaignRecipeCreationPlan(bulk, { orgId: context.actor.orgId, profileId: input.profileId,
    marketplaceId: source.profile.marketplace.marketplaceId, currencyCode: source.profile.currencyCode, now,
    expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(), uuid: randomUUID, hasher: { algorithm: 'sha256', digest } });
  const draft = await saveCampaignDraft(context, { id: input.id, expectedRevision: input.expectedRevision, plan, recipe,
    rationale: recipe.keywords.map((keyword) => ({ keyword: keyword.text, frozenAt: now,
      sentence: campaignBidRationale({ keyword: keyword.text, bid: keyword.bid, basis: keyword.basis,
        currency: source.profile.currencyCode, topOfSearch: recipe.topOfSearch, audienceAdjustment: recipe.audienceAdjustment,
        evidence: builderBidEvidence(source, keyword.text) }) })) });
  return input.validate ? validateSavedBuilderDraft(context, input.profileId, draft.id, draft.revision) : draft;
}
export async function exportBuilderDraft(context: AuthenticatedReadSnapshot, profileId: string, id: string) {
  const draft = await readCampaignDraft(context, profileId, id);
  if (!draft) throw new Error('Draft unavailable');
  const source = await loadCampaignBuilderContext(context, profileId);
  const names = await context.sql<{ name: string }[]>`select name from public.campaigns where org_id=${context.actor.orgId}::uuid and profile_id=${profileId}::uuid`;
  const checked = validateBuilderDraft(draft, source, names.map((row) => row.name), new Date().toISOString());
  if (checked.checks.some((check) => check.blocking)) throw new Error('Draft has blocking issues. Edit and validate before exporting.');
  return creationPlanToBulkWorkbook(draft.plan);
}
