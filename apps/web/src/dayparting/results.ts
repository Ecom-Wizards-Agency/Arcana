import { readTimeline } from '@wizard-ads/db';
import type { AuthenticatedReadSnapshot } from '@wizard-ads/db';
import type { DaypartingSchedule, TimelineEvent } from '@wizard-ads/shared';
import { addDays, ATTRIBUTION_SETTLING_DAYS, daysBetween, todayIsoInTimeZone } from '../../app/_lib/periods';
export interface DaypartingResultPeriod { start: string; end: string; spend: number | null; sales: number | null; orders: number | null; acos: number | null; complete: boolean; }
export interface DaypartingResults { before: DaypartingResultPeriod; after: DaypartingResultPeriod; mature: boolean; events: TimelineEvent[]; }
export async function readDaypartingResults(context: AuthenticatedReadSnapshot, schedule: DaypartingSchedule): Promise<DaypartingResults | null> {
  if (!schedule.enabledAt || !schedule.review) return null;
  const enabledDate = todayIsoInTimeZone(schedule.timezone, new Date(schedule.enabledAt)), length = daysBetween(schedule.review.evidence.start, schedule.review.evidence.end);
  const afterStart = addDays(enabledDate, 1), afterEnd = addDays(afterStart, length - 1), beforeEnd = addDays(enabledDate, -1), beforeStart = addDays(beforeEnd, -length + 1);
  const mature = afterEnd < addDays(todayIsoInTimeZone(schedule.timezone), -ATTRIBUTION_SETTLING_DAYS);
  async function period(start: string, end: string): Promise<DaypartingResultPeriod> {
    const [row] = await context.sql<{ spend: number | null; sales: number | null; orders: number | null; days: number }[]>`select sum(cost)::float8 as spend,sum(sales_7d)::float8 as sales,sum(purchases_7d)::float8 as orders,
    count(distinct (campaign_id,date))::int as days from public.fact_campaign_daily where org_id=${context.actor.orgId} and profile_id=${schedule.profileId}
    and campaign_id=any(${schedule.campaignIds}::text[]) and date between ${start}::date and ${end}::date`;
    const spend = row?.spend ?? null, sales = row?.sales ?? null, orders = row?.orders ?? null;
    return {
      start,
      end,
      spend,
      sales,
      orders,
      acos: spend !== null && sales !== null && sales > 0 ? spend / sales : null,
      complete: row?.days === length * schedule.campaignIds.length
    };
  }
  const [before, after, timeline] = await Promise.all([period(beforeStart, beforeEnd), period(afterStart, afterEnd), readTimeline(context, context.actor.orgId, schedule.profileId)]);
  return {
    before,
    after,
    mature: mature && before.complete && after.complete,
    events: timeline.events.filter(event => event.start <= afterEnd && (event.end === null || event.end >= beforeStart))
  };
}
