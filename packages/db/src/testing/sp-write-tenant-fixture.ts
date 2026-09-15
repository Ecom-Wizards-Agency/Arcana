/** Add archived SP storage fixtures to the current canonical tenant fixture.
 * Kept in the test package because operational seed files are outside this round.
 * These opaque artifacts prove RLS only and cannot pass write admission.
 */
export function extendSpWriteTenantFixture(source: string): string {
  const anchor0 = `  insert into public.sp_write_plan_actions`;
  if (source.split(anchor0).length !== 2) throw new Error('SP fixture anchor count changed');
  source = source.replace(anchor0, `  -- Generic RLS fixture only, like the inert SP plan above. It is deliberately
  -- not an application-valid preview and cannot pass artifact verification.
  if to_regclass('public.sp_write_preview_evidence') is not null then
    insert into public.sp_write_preview_evidence
      (plan_id, org_id, profile_id, artifact_text, artifact, guardrail_preimage, provenance_preimage)
    values (v_sp_plan, v_org, v_profile, '{}', '{}'::jsonb, '[]', '[]');
  end if;
` + anchor0);
  const anchor1 = `  insert into public.sp_write_late_result_audits`;
  if (source.split(anchor1).length !== 2) throw new Error('SP fixture anchor count changed');
  source = source.replace(anchor1, `  if to_regclass('public.sp_write_mirror_observations') is not null then
    -- Tenant/RLS coverage only, like the deliberately opaque source artifacts above.
    insert into public.sp_write_mirror_observations
      (observation_id, org_id, profile_id, execution_id, plan_id, action_id, observation_fingerprint,
       outcome, artifact, reconciled_at)
    values (v_sp_observation, v_org, v_profile, v_sp_execution, v_sp_plan, v_sp_intent_action,
      md5(p_slug || ':sp-observation') || md5(p_slug || ':sp-observation:2'), 'already_current',
      jsonb_build_object(
        'schemaVersion', 'openspell.sp-write-mirror-receipt.v1',
        'orgId', v_org::text, 'profileId', v_profile::text, 'executionId', v_sp_execution::text, 'planId', v_sp_plan::text,
        'observationId', v_sp_observation::text, 'observationFingerprint', md5(p_slug || ':sp-observation') || md5(p_slug || ':sp-observation:2'),
        'actionId', v_sp_intent_action::text, 'amazonEntityId', 'kw-1', 'changeKey', 'keyword.bid',
        'observationOutcome', 'observed_requested', 'outcome', 'already_current',
        'before', jsonb_build_object('amount', '0.9', 'currencyCode', 'USD'),
        'observed', jsonb_build_object('amount', '0.9', 'currencyCode', 'USD'),
        'after', jsonb_build_object('amount', '0.9', 'currencyCode', 'USD'),
        'entityChangeId', null, 'changeAttribution', null,
        'observedAt', app.keyword_mirror_instant(now() - interval '3 minutes'),
        'reconciledAt', app.keyword_mirror_instant(now() - interval '2 minutes'),
        'bidObservedAt', app.keyword_mirror_instant(now() - interval '3 minutes')
      ), now() - interval '2 minutes');
  end if;
` + anchor1);
  return source;
}
