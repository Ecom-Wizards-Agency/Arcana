import { createHash } from 'node:crypto';
import { CampaignDraft, CampaignBuilderRecipe, CampaignBuilderValidation, verifyCampaignCreationPlanFingerprints, Uuid } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';

type Context = AuthenticatedEditorTransaction | AuthenticatedReadSnapshot;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hasher = { algorithm: 'sha256' as const, digest };
export class CampaignDraftConflict extends Error { constructor() { super('The draft changed. Reload it before saving or validating.'); } }

export async function readCampaignDraft(context: Context, profileId: string, id: string): Promise<CampaignDraft | null> {
  Uuid.parse(profileId); Uuid.parse(id);
  const rows = await context.sql<{ record: unknown }[]>`
    select jsonb_build_object('id',id,'orgId',org_id,'profileId',profile_id,'createdBy',created_by,
      'status',status,'revision',revision,'plan',plan,'recipe',recipe,'rationale',rationale,'validation',validation,
      'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as record
    from public.campaign_drafts where org_id = ${context.actor.orgId}::uuid and profile_id = ${profileId}::uuid
      and created_by = ${context.actor.userId}::uuid and id = ${id}::uuid
  `;
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('Draft read count mismatch');
  const draft = CampaignDraft.parse(rows[0]!.record);
  verifyCampaignCreationPlanFingerprints(draft.plan, hasher);
  if (draft.validation !== null && draft.validation.recipeFingerprint !== digest(JSON.stringify(draft.recipe))) throw new Error('Draft recipe validation mismatch');
  return draft;
}

export async function saveCampaignDraft(context: AuthenticatedEditorTransaction, input: {
  id: string; expectedRevision: number | null; plan: CampaignDraft['plan']; recipe: CampaignDraft['recipe']; rationale: CampaignDraft['rationale'];
}): Promise<CampaignDraft> {
  Uuid.parse(input.id);
  const plan = verifyCampaignCreationPlanFingerprints(input.plan, hasher);
  const recipe = CampaignBuilderRecipe.parse(input.recipe);
  const rationale = CampaignDraft.shape.rationale.parse(input.rationale);
  if (plan.orgId !== context.actor.orgId) throw new Error('Draft scope mismatch');
  const rows = input.expectedRevision === null
    ? await context.sql`insert into public.campaign_drafts(id,org_id,profile_id,created_by,plan,recipe,rationale)
        values (${input.id}::uuid,${context.actor.orgId}::uuid,${plan.profileId}::uuid,${context.actor.userId}::uuid,
          ${JSON.stringify(plan)}::text::jsonb,${JSON.stringify(recipe)}::text::jsonb,${JSON.stringify(rationale)}::text::jsonb) returning id`
    : await context.sql`update public.campaign_drafts set plan=${JSON.stringify(plan)}::text::jsonb, recipe=${JSON.stringify(recipe)}::text::jsonb,
        rationale=${JSON.stringify(rationale)}::text::jsonb, status='draft', validation=null, revision=revision+1
        where id=${input.id}::uuid and org_id=${context.actor.orgId}::uuid and profile_id=${plan.profileId}::uuid
          and created_by=${context.actor.userId}::uuid and revision=${input.expectedRevision} and status <> 'approved' returning id`;
  if (rows.length !== 1) throw new CampaignDraftConflict();
  const draft = await readCampaignDraft(context, plan.profileId, input.id);
  if (draft === null) throw new Error('Saved draft unavailable');
  return draft;
}

/** Only the server validation service supplies this result, never the request body. */
export async function recordCampaignDraftValidation(context: AuthenticatedEditorTransaction, draft: CampaignDraft, raw: CampaignBuilderValidation): Promise<CampaignDraft> {
  const validation = CampaignBuilderValidation.parse(raw);
  if (draft.createdBy !== context.actor.userId || draft.orgId !== context.actor.orgId
    || validation.planFingerprint !== draft.plan.fingerprint || validation.recipeFingerprint !== digest(JSON.stringify(draft.recipe))) throw new CampaignDraftConflict();
  const status = validation.checks.some((check) => check.blocking) ? 'blocked' : 'validated';
  const rows = await context.sql`update public.campaign_drafts set status=${status},validation=${JSON.stringify(validation)}::text::jsonb,revision=revision+1
    where id=${draft.id}::uuid and org_id=${context.actor.orgId}::uuid and created_by=${context.actor.userId}::uuid
      and revision=${draft.revision} and plan->>'fingerprint'=${validation.planFingerprint} and status <> 'approved' returning id`;
  if (rows.length !== 1) throw new CampaignDraftConflict();
  const updated = await readCampaignDraft(context, draft.profileId, draft.id);
  if (!updated) throw new Error('Validated draft unavailable');
  return updated;
}
