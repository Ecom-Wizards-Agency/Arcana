import type { SponsoredPromptAnalysis, SponsoredPromptDisplayRow, SponsoredPromptMetrics, SponsoredPromptObservation, SponsoredPromptSnapshot } from '@wizard-ads/shared';

function metrics(rows: readonly SponsoredPromptObservation[]): SponsoredPromptMetrics {
  const sum = (key: 'spend' | 'clicks' | 'sales' | 'orders') => rows.length === 0 || rows.some((row) => row[key] === null)
    ? null : rows.reduce((value, row) => value + row[key]!, 0);
  const spend = sum('spend'); const sales = sum('sales');
  return { spend, sales, clicks: sum('clicks'), orders: sum('orders'), acos: spend === null || sales === null || sales <= 0 ? null : spend / sales };
}

/** Disjoint intervals are never prorated across an unobserved cutoff. */
export function analyzeSponsoredPrompts(snapshot: SponsoredPromptSnapshot): SponsoredPromptAnalysis {
  const allObservations = snapshot.prompts.flatMap((prompt) => prompt.observations);
  const rows: SponsoredPromptDisplayRow[] = [];
  let pausedPrompts = 0; let returnedPrompts = 0; let returns = 0;
  const pauseGaps: number[] = [];
  for (const prompt of snapshot.prompts) {
    const observations = [...prompt.observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const pauseDates: string[] = []; const returnDates: string[] = [];
    for (const [index, observation] of observations.entries()) {
      const previous = observations[index - 1];
      if (observation.status === 'paused' && previous?.status !== 'paused') pauseDates.push(observation.observedAt);
      if (observation.status === 'live' && previous?.status === 'paused') returnDates.push(observation.observedAt);
    }
    if (pauseDates.length) pausedPrompts++;
    if (returnDates.length) returnedPrompts++;
    returns += returnDates.length;
    for (let index = 1; index < pauseDates.length; index++) pauseGaps.push((Date.parse(pauseDates[index]!) - Date.parse(pauseDates[index - 1]!)) / 86400000);
    const returnedAt = returnDates.at(-1) ?? null;
    const returnedSinceVisit = returnedAt !== null && (snapshot.lastVisitedAt === null || returnedAt > snapshot.lastVisitedAt);
    const newlySponsored = snapshot.lastVisitedAt === null || prompt.firstSeenAt > snapshot.lastVisitedAt;
    rows.push({ prompt, ...metrics(observations), returnedAt,
      change: returnedSinceVisit ? 'returned' : newlySponsored ? 'newly_sponsored' : 'unchanged' });
  }
  const windowMetrics = (cutoff: string, end: string): SponsoredPromptMetrics => {
    // A crossing interval makes the selected window unmeasured, rather than inventing its daily split.
    if (allObservations.some((row) => (row.intervalStart < cutoff && row.intervalEnd > cutoff) || (row.intervalStart < end && row.intervalEnd > end))) return metrics([]);
    return metrics(allObservations.filter((row) => row.intervalStart >= cutoff && row.intervalEnd <= end));
  };
  return { changed: rows.filter((row) => row.change !== 'unchanged'), unchanged: rows.filter((row) => row.change === 'unchanged'),
    live: snapshot.prompts.filter((prompt) => prompt.currentStatus === 'live').length,
    paused: snapshot.prompts.filter((prompt) => prompt.currentStatus === 'paused').length,
    thirtyDays: windowMetrics(snapshot.windowStart, snapshot.windowEnd), sinceVisit: snapshot.lastVisitedAt === null ? null : windowMetrics(snapshot.lastVisitedAt, snapshot.viewedThrough),
    loop: { pausedPrompts, returnedPrompts, returns,
      meanReturnsPerPausedPrompt: pausedPrompts === 0 ? null : returns / pausedPrompts,
      meanDaysBetweenPauses: pauseGaps.length === 0 ? null : pauseGaps.reduce((sum, gap) => sum + gap, 0) / pauseGaps.length } };
}
