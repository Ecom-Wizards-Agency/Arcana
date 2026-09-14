import { TargetTranslation, TranslationRequest, TranslationRetry, type TargetTranslationJob, type TranslationLanguage, TranslationStatus } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';

interface TranslationRow {
  id: string; org_id: string; profile_id: string; original_text: string; language: string; status: string;
  translated_text: string | null; reason: string | null; provider_id: string; request_id: string;
  requested_by: string; requested_at: Date | string; completed_at: Date | string | null;
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
function parse(row: TranslationRow): TargetTranslation {
  return TargetTranslation.parse({ id: row.id, orgId: row.org_id, profileId: row.profile_id, originalText: row.original_text,
    language: row.language, providerId: row.provider_id, result: { status: row.status, text: row.translated_text, reason: row.reason },
    provenance: { requestedAt: iso(row.requested_at), completedAt: row.completed_at === null ? null : iso(row.completed_at), requestedBy: row.requested_by, requestId: row.request_id } });
}

export async function listTargetTranslations(handle: QueryHandle, orgId: string, profileId: string, language?: TranslationLanguage): Promise<TargetTranslation[]> {
  const rows = await handle.sql<TranslationRow[]>`select * from public.target_translations
    where org_id=${orgId} and profile_id=${profileId} and (${language ?? null}::text is null or language=${language ?? null}) order by requested_at desc, id`;
  return rows.map(parse);
}

export async function requestTargetTranslation(context: AuthenticatedEditorTransaction, raw: unknown): Promise<TargetTranslation> {
  const input = TranslationRequest.parse(raw);
  const rows = await context.sql<{ id: string }[]>`select app.request_target_translation(${context.actor.orgId},${input.profileId},${input.originalText},${input.language},null) as id`;
  const id = rows[0]?.id;
  const saved = await context.sql<TranslationRow[]>`select * from public.target_translations where org_id=${context.actor.orgId} and profile_id=${input.profileId} and id=${id ?? null}`;
  if (rows.length !== 1 || saved.length !== 1) throw new Error('Translation request count mismatch');
  return parse(saved[0]!);
}

export async function retryTargetTranslation(context: AuthenticatedEditorTransaction, raw: unknown): Promise<TargetTranslation> {
  const input = TranslationRetry.parse(raw);
  const rows = await context.sql<{ id: string }[]>`select app.request_target_translation(${context.actor.orgId},${input.profileId},null,null,${input.translationId}) as id`;
  const saved = await context.sql<TranslationRow[]>`select * from public.target_translations where org_id=${context.actor.orgId} and profile_id=${input.profileId} and id=${input.translationId}`;
  if (rows.length !== 1 || rows[0]?.id !== input.translationId || saved.length !== 1) throw new Error('Translation retry count mismatch');
  return parse(saved[0]!);
}

export async function readTranslationAttempt(handle: QueryHandle, job: TargetTranslationJob): Promise<TargetTranslation | null> {
  const rows = await handle.sql<TranslationRow[]>`select * from public.target_translations where org_id=${job.orgId} and profile_id=${job.profileId} and id=${job.translationId} and request_id=${job.requestId}`;
  return rows[0] ? parse(rows[0]) : null;
}

/** An obsolete attempt can never overwrite an operator's newer retry. */
export async function completeTranslationAttempt(handle: QueryHandle, job: TargetTranslationJob, raw: TranslationStatus, providerId: string): Promise<number> {
  const result = TranslationStatus.parse(raw);
  if (result.status === 'waiting') throw new Error('Translation completion cannot be waiting');
  const rows = await handle.sql<{ id: string }[]>`update public.target_translations
    set status=${result.status}, translated_text=${result.text}, reason=${result.reason}, provider_id=${providerId}, completed_at=now()
    where org_id=${job.orgId} and profile_id=${job.profileId} and id=${job.translationId} and request_id=${job.requestId} and status='waiting' returning id`;
  if (rows.length > 1) throw new Error('Translation completion count mismatch');
  return rows.length;
}
