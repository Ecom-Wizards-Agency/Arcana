import { ONE_TIME_RPC_BID_FIELDS, type OneTimeRpcBidSettings } from '@wizard-ads/shared';

/** Prefill a field only when every selected campaign has the same configured value. */
export function commonOneTimeSettings(settings: readonly (Partial<OneTimeRpcBidSettings> | null | undefined)[]): Partial<OneTimeRpcBidSettings> {
  const common: Partial<OneTimeRpcBidSettings> = {};
  for (const field of ONE_TIME_RPC_BID_FIELDS) {
    const first = settings[0]?.[field];
    if (typeof first === 'number' && Number.isFinite(first) && settings.every((candidate) => candidate?.[field] === first)) {
      common[field] = first;
    }
  }
  return common;
}

export function completedPreviewWindow(period: { start: string; end: string }, profileToday: string) {
  const yesterday = new Date(`${profileToday}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const lastComplete = yesterday.toISOString().slice(0, 10);
  const end = period.end < lastComplete ? period.end : lastComplete;
  return { start: period.start <= end ? period.start : '', end, lastComplete };
}
