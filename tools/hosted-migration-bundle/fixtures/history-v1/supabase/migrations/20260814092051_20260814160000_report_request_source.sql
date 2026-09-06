-- wizard-ads 0018: where a report row came from.
alter table public.report_requests
  add column source text not null default 'amazon_api';

alter table public.report_requests
  add constraint report_requests_source_known
  check (source in ('amazon_api', 'adlabs_backfill'));

comment on column public.report_requests.source is
  'Where the rows came from. amazon_api = our own Reporting v3 pull. adlabs_backfill = second-hand history imported from AdLabs; the crosscheck must never read facts that point at one of these.';

create index report_requests_source_idx
  on public.report_requests (profile_id, source, end_date desc);;
