import { OneTimeRpcConfiguration, OneTimeRpcPreviewRequest, MethodSelection, Uuid, methodSelectionFor, type OneTimeRpcBidSettings } from '@wizard-ads/shared';
import type { OptimizerCampaignRow } from '../../optimizer/campaigns';
import { commonOneTimeSettings, completedPreviewWindow } from '../../optimizer/one-time-settings';

/** Only unsubmitted local choices. Saved previews never read this draft. */
export interface OptimizerDraft {
  campaignIds: string[];
  configuration?: OneTimeRpcConfiguration;
  campaignMethods?: Record<string, MethodSelection>;
}
const key = (profileId: string) => `arcana.optimizer.draft.${profileId}`;
const admissionKey = (profileId: string) => `arcana.optimizer.pending-admission.${profileId}`;
export function readOptimizerDraft(profileId: string): OptimizerDraft {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key(profileId)) ?? 'null');
    if (typeof value !== 'object' || value === null || !('campaignIds' in value) || !Array.isArray(value.campaignIds)
      || value.campaignIds.some((id) => typeof id !== 'string')) return { campaignIds: [] };
    const configuration = OneTimeRpcConfiguration.safeParse('configuration' in value ? value.configuration : undefined);
    const methods = 'campaignMethods' in value && typeof value.campaignMethods === 'object' && value.campaignMethods !== null
      ? Object.entries(value.campaignMethods).flatMap(([id, raw]) => { const parsed = MethodSelection.safeParse(raw); return parsed.success ? [[id, parsed.data] as const] : []; }) : [];
    return { campaignIds: [...new Set(value.campaignIds as string[])], ...(configuration.success ? { configuration: configuration.data } : {}), campaignMethods: Object.fromEntries(methods) };
  } catch { return { campaignIds: [] }; }
}
export function saveOptimizerDraft(profileId: string, draft: OptimizerDraft): void {
  sessionStorage.setItem(key(profileId), JSON.stringify(draft));
}

/** Persist identity before dispatch so an uncertain response remains recoverable after reload. */
export function optimizerAdmissionRequest(profileId: string, campaignIds: readonly string[], configuration: OneTimeRpcConfiguration,
  methods: Readonly<Record<string, MethodSelection>> = {}): OneTimeRpcPreviewRequest {
  const ids = [...new Set(campaignIds)].sort();
  const campaignMethods = Object.fromEntries(ids.flatMap((id) => methods[id] === undefined ? [] : [[id, methods[id]]]));
  const fields = { version: 1 as const, profileId, scope: { mode: 'selected' as const, campaignIds: ids }, configuration,
    ...(Object.keys(campaignMethods).length === 0 ? {} : { campaignMethods }) };
  // Schema parsing also gives method and configuration properties canonical order.
  const parsed = OneTimeRpcPreviewRequest.parse({ ...fields, clientRequestId: crypto.randomUUID() });
  const { clientRequestId: freshId, ...canonical } = parsed;
  const identity = JSON.stringify(canonical);
  let clientRequestId = freshId;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(admissionKey(profileId)) ?? 'null');
    if (typeof saved === 'object' && saved !== null && 'identity' in saved && saved.identity === identity
      && 'clientRequestId' in saved && Uuid.safeParse(saved.clientRequestId).success) clientRequestId = String(saved.clientRequestId);
  } catch { /* An unreadable local draft does not supply a recoverable identity. */ }
  sessionStorage.setItem(admissionKey(profileId), JSON.stringify({ identity, clientRequestId }));
  return { ...parsed, clientRequestId };
}

export function clearOptimizerAdmission(profileId: string, clientRequestId: string): void {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(admissionKey(profileId)) ?? 'null');
    if (typeof stored === 'object' && stored !== null && 'clientRequestId' in stored && stored.clientRequestId === clientRequestId) {
      sessionStorage.removeItem(admissionKey(profileId));
    }
  } catch { /* A saved batch URL already provides recovery after a confirmed response. */ }
}

export function draftDefaultMethod(draft: OptimizerDraft): MethodSelection {
  return methodSelectionFor(draft.configuration?.method ?? 'sp.reference-efficiency');
}
export function savedConfiguration(rows: readonly OptimizerCampaignRow[], period: { start: string; end: string }, today: string): OneTimeRpcConfiguration | null {
  const common = rows.length > 0 && rows.every((row) => row.groupId !== null)
    ? rows[0]?.oneTimeSettings ?? {} : commonOneTimeSettings(rows.map((row) => row.oneTimeSettings));
  const { start, end } = completedPreviewWindow(period, today);
  const parsed = OneTimeRpcConfiguration.safeParse({ version: 1, method: 'sp.reference-efficiency', ...common, window: { start, end } });
  return parsed.success ? parsed.data : null;
}
export function effectiveAcos(row: OptimizerCampaignRow, run?: Partial<OneTimeRpcBidSettings>): { value: number | null; source: string } {
  const value = row.groupId !== null ? row.oneTimeSettings?.targetAcos : run?.targetAcos;
  return { value: value != null && value > 0 ? value : null, source: row.groupId !== null ? `${row.groupName ?? 'Assigned group'} · group` : 'Temporary run field' };
}
