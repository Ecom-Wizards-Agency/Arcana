/** Actor-bound entry points for human review and offline export mutations. */
import { OrgRole, ORG_CAPABILITY_ROLES, type OrgCapability } from '@wizard-ads/shared';
import { AgencyAccessDenied, type AuthenticatedEditorTransaction } from './authenticated-actor.js';
import { decideRecommendations, exportAcceptedRecommendations, type createNegativeProposals } from './recommendations.js';
import { createReversionExport } from './time-machine.js';

async function requireWriteCapability(context: AuthenticatedEditorTransaction, capability: OrgCapability): Promise<void> {
  const [member] = await context.sql<{ role: string }[]>`select role::text as role from public.org_members
    where org_id=${context.actor.orgId} and user_id=auth.uid()`;
  const role = OrgRole.safeParse(member?.role);
  if (!role.success || !(ORG_CAPABILITY_ROLES[capability] as readonly OrgRole[]).includes(role.data)) {
    throw new AgencyAccessDenied();
  }
}

export async function decideRecommendationsForActor(
  context: AuthenticatedEditorTransaction,
  input: Omit<Parameters<typeof decideRecommendations>[1], 'orgId' | 'actorId'>,
) {
  await requireWriteCapability(context, 'editTargets');
  const result = await decideRecommendations(context, { ...input, orgId: context.actor.orgId, actorId: context.actor.userId });
  const unique = new Set(input.ids).size;
  const matched = result.updated + result.refused.length;
  if (matched > unique) throw new Error('Recommendation decision counts do not reconcile');
  return { ...result, unique, duplicates: input.ids.length - unique, matched, unmatched: unique - matched };
}

export async function exportAcceptedRecommendationsForActor(
  context: AuthenticatedEditorTransaction,
  input: Omit<Parameters<typeof exportAcceptedRecommendations>[1], 'orgId' | 'actorId'>,
) {
  await requireWriteCapability(context, 'exportBatches');
  return exportAcceptedRecommendations(context, { ...input, orgId: context.actor.orgId, actorId: context.actor.userId });
}

export async function createNegativeProposalsForActor(
  context: AuthenticatedEditorTransaction,
  input: Omit<Parameters<typeof createNegativeProposals>[1], 'orgId' | 'actorId'>,
) {
  await requireWriteCapability(context, 'editTargets');
  const [result] = await context.sql<{ run_id: string; created: number }[]>`select * from app.create_ngram_review_proposals(
    ${context.actor.orgId}::uuid,${input.profileId}::uuid,${input.window.start}::date,${input.window.end}::date,
    ${input.lookbackDays}::integer,${JSON.stringify(input.proposals)}::text::jsonb)`;
  if (!result || result.created !== input.proposals.length) throw new Error('Negative proposal count mismatch');
  return { runId: result.run_id, created: result.created };
}

export async function createReversionExportForActor(
  context: AuthenticatedEditorTransaction,
  input: Omit<Parameters<typeof createReversionExport>[1], 'orgId' | 'actorId'>,
) {
  await requireWriteCapability(context, 'exportBatches');
  return createReversionExport(context, { ...input, orgId: context.actor.orgId, actorId: context.actor.userId });
}
