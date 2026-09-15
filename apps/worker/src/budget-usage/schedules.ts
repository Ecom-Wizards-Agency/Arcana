import type { DbHandle } from '@wizard-ads/db';

/** Provision only explicitly enabled API reads; Stream continues from normalization. */
export async function ensureBudgetUsageSchedules(handle: DbHandle, apiEnabled: boolean): Promise<number> {
  const [relation] = await handle.sql<{ relation: string | null }[]>`
    select to_regclass('public.budget_usage_settings')::text as relation
  `;
  if (!relation?.relation) return 0;
  const [result] = await handle.sql<{ changed: number }[]>`
    with expected as (
      select settings.org_id, settings.profile_id,
             make_interval(mins => coalesce((settings.config->>'cadenceMinutes')::integer, 60)) as cadence
        from public.budget_usage_settings settings
        join public.ad_profiles profile on profile.id = settings.profile_id and profile.org_id = settings.org_id
       where ${apiEnabled} and profile.sync_enabled and settings.config->>'apiEnabled' = 'true'
    ), disabled as (
      update public.sync_schedules schedule set enabled = false
       where schedule.job_type = 'budget_usage.collect' and schedule.variant = 'budget-usage' and schedule.enabled
         and not exists (select 1 from expected e where e.org_id = schedule.org_id and e.profile_id = schedule.profile_id)
      returning schedule.id
    ), provisioned as (
      insert into public.sync_schedules (org_id, profile_id, job_type, variant, cadence, payload, enabled)
      select org_id, profile_id, 'budget_usage.collect', 'budget-usage', cadence, '{}'::jsonb, true from expected
      on conflict (profile_id, job_type, report_type, variant) do update
        set cadence = excluded.cadence, enabled = true
        where not sync_schedules.enabled or sync_schedules.cadence is distinct from excluded.cadence
      returning id
    ) select ((select count(*) from disabled) + (select count(*) from provisioned))::integer as changed
  `;
  return result?.changed ?? 0;
}
