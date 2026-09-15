set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Coverage is an integration seam; other report/attribution source enums remain closed.
alter table public.report_coverage
  alter column source type text using source::text,
  add constraint report_coverage_source_nonempty check (btrim(source) <> ''),
  add column source_rows bigint,
  add column parsed_rows bigint,
  add column loaded_rows bigint,
  add column refused_rows bigint,
  add column observed_at timestamptz,
  add column counts_match boolean,
  add constraint report_coverage_counts_nonnegative check (
    (source_rows is null or source_rows >= 0) and
    (parsed_rows is null or parsed_rows >= 0) and
    (loaded_rows is null or loaded_rows >= 0) and
    (refused_rows is null or refused_rows >= 0)
  );
comment on column public.report_coverage.observed_at is
  'Successful load observation time, distinct from metadata updated_at. Null for legacy coverage.';
comment on column public.report_coverage.counts_match is
  'Producer load assertion. Parsed source rows may aggregate into fewer loaded fact rows.';
