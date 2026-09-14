-- Review exports need locks on service-owned mirrors, without mirror DML grants.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.lock_review_export_rows(p_org uuid, p_profile uuid, p_run uuid, p_targets jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.lock_org_manager(p_org);
  if not exists(select 1 from public.ad_profiles where org_id=p_org and id=p_profile) then
    raise exception using errcode='42501', message='Resource not found';
  end if;
  if p_run is not null then
    perform id from public.recommendation_runs where org_id=p_org and profile_id=p_profile and id=p_run for share;
    if not found then raise exception using errcode='42501', message='Resource not found'; end if;
  end if;
  perform k.id from public.keywords k where k.org_id=p_org and k.profile_id=p_profile
    and k.amazon_id in (select t->>'entityId' from jsonb_array_elements(p_targets) t where t->>'entityType'='keyword') order by k.id for share;
  perform k.id from public.targets k where k.org_id=p_org and k.profile_id=p_profile
    and k.amazon_id in (select t->>'entityId' from jsonb_array_elements(p_targets) t where t->>'entityType'='target') order by k.id for share;
  perform k.id from public.campaigns k where k.org_id=p_org and k.profile_id=p_profile
    and k.amazon_id in (select t->>'entityId' from jsonb_array_elements(p_targets) t where t->>'entityType' in ('campaign','placement')) order by k.id for share;
  perform k.id from public.ad_groups k where k.org_id=p_org and k.profile_id=p_profile
    and k.amazon_id in (select t->>'entityId' from jsonb_array_elements(p_targets) t where t->>'entityType'='ad_group') order by k.id for share;
end;
$$;
revoke all on function app.lock_review_export_rows(uuid,uuid,uuid,jsonb) from public, anon, service_role;
grant execute on function app.lock_review_export_rows(uuid,uuid,uuid,jsonb) to authenticated;

-- Only application review actions on this actor's already-written rows may append.
create function app.record_recommendation_review_audit(p_org uuid, p_action text, p_type text, p_ids text[], p_payload jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_count integer;
begin
  perform app.lock_org_editor(p_org);
  if cardinality(p_ids) is null or cardinality(p_ids)=0
    or cardinality(p_ids)<>(select count(distinct id) from unnest(p_ids) id) then
    raise exception using errcode='22023', message='Invalid review audit selection';
  end if;
  if p_type='recommendation' and p_action in ('recommendation.accepted','recommendation.dismissed','recommendation.proposed') then
    if (select count(*) from public.recommendations where org_id=p_org and id::text=any(p_ids)
        and status::text=split_part(p_action,'.',2)
        and (decided_by=auth.uid() or (status='proposed' and decided_by=auth.uid())))<>cardinality(p_ids) then
      raise exception using errcode='42501', message='Resource not found';
    end if;
  elsif p_type='apply_batch' and p_action in ('recommendation.exported','reversion.exported') then
    perform app.lock_org_manager(p_org);
    if (select count(*) from public.apply_batches where org_id=p_org and id::text=any(p_ids)
        and created_by=auth.uid() and status='staged')<>cardinality(p_ids) then
      raise exception using errcode='42501', message='Resource not found';
    end if;
  else
    raise exception using errcode='42501', message='Resource not found';
  end if;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    select p_org,'user',auth.uid()::text,p_action,p_type,id,p_payload,'web' from unnest(p_ids) id;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;
revoke all on function app.record_recommendation_review_audit(uuid,text,text,text[],jsonb) from public, anon, service_role;
grant execute on function app.record_recommendation_review_audit(uuid,text,text,text[],jsonb) to authenticated;

-- Human n-gram proposals are a distinct lineage; no worker-owned run can be edited.
create function app.create_ngram_review_proposals(p_org uuid,p_profile uuid,p_start date,p_end date,p_days integer,p_proposals jsonb)
returns table(run_id uuid,created integer) language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_run uuid; v_count integer; v_offered integer;
begin
  perform app.lock_org_editor(p_org);
  if not exists(select 1 from public.ad_profiles where org_id=p_org and id=p_profile) then
    raise exception using errcode='42501', message='Resource not found';
  end if;
  v_offered:=jsonb_array_length(p_proposals);
  if v_offered<1 or p_start>p_end or p_days<>p_end-p_start+1 then
    raise exception using errcode='22023', message='Invalid proposal window or selection';
  end if;
  if exists(select 1 from jsonb_array_elements(p_proposals) p where
      coalesce(btrim(p->>'searchTerm'),'')='' or coalesce(p->>'matchType','') not in ('negative_exact','negative_phrase')
      or not exists(select 1 from public.campaigns c where c.org_id=p_org and c.profile_id=p_profile and c.amazon_id=p->>'campaignId')
      or (p->>'adGroupId' is not null and not exists(select 1 from public.ad_groups g where g.org_id=p_org
        and g.profile_id=p_profile and g.amazon_id=p->>'adGroupId' and g.campaign_id=p->>'campaignId'))) then
    raise exception using errcode='42501', message='Resource not found';
  end if;
  insert into public.recommendation_runs(org_id,profile_id,status,lookback_days,window_start,window_end,engine_version,
      proposals_count,started_at,finished_at,execution_lineage)
    values(p_org,p_profile,'succeeded',p_days,p_start,p_end,'ngram-explorer',v_offered,now(),now(),'human') returning id into v_run;
  insert into public.recommendations(run_id,org_id,profile_id,reason,entity_type,entity_id,ad_product,campaign_id,ad_group_id,
      entity_name,field,current_value,proposed_value,inputs,status)
    select v_run,p_org,p_profile,'flag','negative',coalesce(p->>'adGroupId',p->>'campaignId')||':'||(p->>'searchTerm'),
      'SP',p->>'campaignId',p->>'adGroupId',p->>'searchTerm','negative_keyword',null,p->'matchType',p->'inputs','proposed'
      from jsonb_array_elements(p_proposals) p;
  get diagnostics v_count=row_count;
  if v_count<>v_offered then raise exception 'Proposal count mismatch'; end if;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'user',auth.uid()::text,'recommendation.proposed','recommendation_run',v_run::text,
      jsonb_build_object('proposals',v_count,'source','ngram-explorer'),'web');
  return query select v_run,v_count;
end;
$$;
revoke all on function app.create_ngram_review_proposals(uuid,uuid,date,date,integer,jsonb) from public, anon, service_role;
grant execute on function app.create_ngram_review_proposals(uuid,uuid,date,date,integer,jsonb) to authenticated;

-- Locking these service-owned proposals is a narrow command, not a DML grant.
create function app.lock_query_negative_review(p_org uuid,p_profile uuid,p_market text,p_ids uuid[],p_export boolean)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.lock_org_editor(p_org);
  if p_export then perform app.lock_org_manager(p_org); end if;
  if cardinality(p_ids) is null or cardinality(p_ids) not between 1 and 500 or cardinality(p_ids)<>(select count(distinct id) from unnest(p_ids) id) then
    raise exception using errcode='22023',message='Invalid review selection';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(E'wizard-ads.contextual-negative-review-scope.v1\n'||p_org::text||E'\n'||p_profile::text||E'\n'||p_market,0));
  perform id from public.contextual_negative_proposals where org_id=p_org and profile_id=p_profile
    and marketplace_id=p_market and id=any(p_ids) order by id::text collate "C" for update;
end;
$$;
revoke all on function app.lock_query_negative_review(uuid,uuid,text,uuid[],boolean) from public,anon,service_role;
grant execute on function app.lock_query_negative_review(uuid,uuid,text,uuid[],boolean) to authenticated;

create function app.query_negative_snapshot(p public.contextual_negative_proposals)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('orgId',p.org_id,'id',p.id,'profileId',p.profile_id,'marketplaceId',p.marketplace_id,
    'campaignId',p.campaign_id,'adGroupId',p.ad_group_id,'searchTerm',p.search_term,'normalizedQuery',p.normalized_query,
    'category',p.category,'sourceGroupRole',p.source_group_role,'matchType',p.match_type,'reason',p.reason,'status',p.status)
$$;
revoke all on function app.query_negative_snapshot(public.contextual_negative_proposals) from public,anon,service_role;

-- Frozen v1 fingerprint and CSV encoding, also checked for direct RPC callers.
create function app.query_negative_review_fingerprint(p jsonb)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(E'wizard-ads.contextual-negative-review-fingerprint.v1\n[' ||
    string_agg(to_json(p->>k)::text,',' order by n) || E']\n','UTF8')),'hex')
  from unnest(array['orgId','id','profileId','marketplaceId','campaignId','adGroupId','searchTerm','normalizedQuery',
    'category','sourceGroupRole','matchType','reason','status']) with ordinality keys(k,n)
$$;
revoke all on function app.query_negative_review_fingerprint(jsonb) from public,anon,service_role;

create function app.query_negative_csv_cell(p text)
returns text language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_offset integer:=1; v_code integer; v_literal text:=p;
begin
  -- Code-point ranges for the JavaScript encoder's whitespace/control/format prefix.
  while v_offset<=length(p) loop
    v_code:=ascii(substr(p,v_offset,1));
    exit when not (v_code between 0 and 32 or v_code between 127 and 160 or v_code=173 or v_code between 1536 and 1541 or v_code=1564 or v_code=1757 or v_code=1807 or v_code between 2192 and 2193 or v_code=2274 or v_code=5760 or v_code=6158 or v_code between 8192 and 8207 or v_code between 8232 and 8239 or v_code between 8287 and 8292 or v_code between 8294 and 8303 or v_code=12288 or v_code=65279 or v_code between 65529 and 65531 or v_code=69821 or v_code=69837 or v_code between 78896 and 78911 or v_code between 113824 and 113827 or v_code between 119155 and 119162 or v_code=917505 or v_code between 917536 and 917631);
    v_offset:=v_offset+1;
  end loop;
  if substr(p,v_offset,1) in ('=','+','-','@') then v_literal:=chr(39)||p; end if;
  if position('"' in v_literal)>0 or position(',' in v_literal)>0 or position(chr(10) in v_literal)>0 or position(chr(13) in v_literal)>0 then
    v_literal:='"'||replace(v_literal,'"','""')||'"';
  end if;
  return v_literal;
end;
$$;
revoke all on function app.query_negative_csv_cell(text) from public,anon,service_role;

create function app.query_negative_csv(p jsonb)
returns bytea language sql immutable set search_path = pg_catalog, pg_temp as $$
  select convert_to(E'org_id,id,profile_id,marketplace_id,campaign_id,ad_group_id,search_term,normalized_query,category,source_group_role,match_type,reason,status,review_fingerprint,amazon_updated\n'
    ||coalesce(string_agg(line,E'\n' order by row_num),'')||E'\n','UTF8')
  from (select row_num,string_agg(app.query_negative_csv_cell(case when k='amazonUpdated' then 'false' else proposal->>k end),',' order by n) as line
    from jsonb_array_elements(p) with ordinality rows(proposal,row_num),
      unnest(array['orgId','id','profileId','marketplaceId','campaignId','adGroupId','searchTerm','normalizedQuery',
        'category','sourceGroupRole','matchType','reason','status','reviewFingerprint','amazonUpdated']) with ordinality keys(k,n)
    group by row_num) lines
$$;
revoke all on function app.query_negative_csv(jsonb) from public,anon,service_role;

-- The app has already compared immutable fingerprints under the same row locks.
-- Recheck the complete before-values here for direct authenticated RPC callers.
create function app.apply_query_negative_review(p_org uuid,p_profile uuid,p_market text,p_before jsonb,p_status text,p_note text,
  p_export_id uuid default null,p_created timestamptz default null,p_json bytea default null,p_csv bytea default null)
returns table(id uuid,status text,updated_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_ids uuid[]; v_changed integer; v_audits integer; v_envelope jsonb; v_json_hash text; v_csv_hash text;
begin
  select array_agg((p->>'id')::uuid order by p->>'id') into v_ids from jsonb_array_elements(p_before) p;
  perform app.lock_query_negative_review(p_org,p_profile,p_market,v_ids,p_export_id is not null);
  if octet_length(p_before::text)>8388608 or octet_length(coalesce(p_note,''))>16384 then
    raise exception using errcode='22023',message='Review capacity exceeded';
  end if;
  if p_status not in ('accepted','dismissed','proposed','exported') or p_status is null
    or ((p_status='exported') is distinct from (p_export_id is not null))
    or (p_status in ('dismissed','exported') and coalesce(btrim(p_note),'')='') then
    raise exception using errcode='22023',message='Invalid review decision';
  end if;
  if (select count(*) from public.contextual_negative_proposals p join jsonb_array_elements(p_before) b
      on p.id=(b->>'id')::uuid where p.org_id=p_org and p.profile_id=p_profile and p.marketplace_id=p_market
      and app.query_negative_snapshot(p)=b-'reviewFingerprint'
      and b->>'reviewFingerprint'=app.query_negative_review_fingerprint(b)
      and p.status<>'exported' and (p_export_id is null or p.status='accepted'))<>cardinality(v_ids) then
    raise exception using errcode='40001',message='Review selection changed';
  end if;
  if p_export_id is null then
    insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
      select p_org,'user',auth.uid()::text,
        case p_status when 'proposed' then 'query_negative.reopened' else 'query_negative.'||p_status end,
        'contextual_negative_proposal',p.id::text,
        jsonb_build_object('before',b,'targetStatus',p_status,'note',coalesce(p_note,'')),'web'
        from public.contextual_negative_proposals p join jsonb_array_elements(p_before) b on p.id=(b->>'id')::uuid
        where p.org_id=p_org and p.profile_id=p_profile and p.marketplace_id=p_market and p.status<>p_status;
    get diagnostics v_audits=row_count;
  else
    if p_csv is distinct from app.query_negative_csv(p_before) then
      raise exception using errcode='22023',message='Invalid review CSV';
    end if;
    v_envelope:=convert_from(p_json,'UTF8')::jsonb;
    if v_envelope->'version' is distinct from '1'::jsonb or v_envelope->'proposals' is distinct from p_before or v_envelope->>'exportId' is distinct from p_export_id::text
      or v_envelope->>'orgId' is distinct from p_org::text or v_envelope->>'profileId' is distinct from p_profile::text
      or v_envelope->>'marketplaceId' is distinct from p_market or v_envelope->>'note' is distinct from p_note
      or v_envelope->'amazonUpdated' is distinct from 'false'::jsonb
      or v_envelope->>'rowCount' is distinct from cardinality(v_ids)::text
      or (v_envelope->>'createdAt')::timestamptz is distinct from p_created then
      raise exception using errcode='22023',message='Invalid review artifact';
    end if;
    v_json_hash:=encode(sha256(p_json),'hex'); v_csv_hash:=encode(sha256(p_csv),'hex');
    insert into public.contextual_negative_exports(id,org_id,profile_id,marketplace_id,note,row_count,
      json_artifact,json_sha256,csv_artifact,csv_sha256,created_by,created_at)
      values(p_export_id,p_org,p_profile,p_market,p_note,cardinality(v_ids),p_json,v_json_hash,p_csv,v_csv_hash,auth.uid()::text,p_created);
    insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
      values(p_org,'user',auth.uid()::text,'query_negative.exported','contextual_negative_export',p_export_id::text,
        jsonb_build_object('exportId',p_export_id,'scope',jsonb_build_object('orgId',p_org,'profileId',p_profile,'marketplaceId',p_market),
          'proposalIds',to_jsonb(v_ids),'proposalFingerprints',(select jsonb_agg(p->'reviewFingerprint' order by p->>'id') from jsonb_array_elements(p_before) p),
          'rowCount',cardinality(v_ids),'jsonSha256',v_json_hash,'csvSha256',v_csv_hash,'note',p_note,'amazonUpdated',false),'web');
    v_audits:=cardinality(v_ids);
  end if;
  return query update public.contextual_negative_proposals p set status=p_status,updated_at=transaction_timestamp()
    where p.org_id=p_org and p.profile_id=p_profile and p.marketplace_id=p_market and p.id=any(v_ids) and p.status<>p_status
    returning p.id,p.status,p.updated_at;
  get diagnostics v_changed=row_count;
  if v_changed<>v_audits then raise exception 'Review audit count mismatch'; end if;
end;
$$;
revoke all on function app.apply_query_negative_review(uuid,uuid,text,jsonb,text,text,uuid,timestamptz,bytea,bytea) from public,anon,service_role;
grant execute on function app.apply_query_negative_review(uuid,uuid,text,jsonb,text,text,uuid,timestamptz,bytea,bytea) to authenticated;
