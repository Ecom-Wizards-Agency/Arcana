set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Durable create ambiguity and attended resolution evidence. Kept separately
-- from error, which ordinary polling/completion clears or replaces.
alter table public.report_requests add column reconciliation jsonb;
comment on column public.report_requests.reconciliation is
  'Versioned ambiguous-create evidence and operator resolution audit; never contains credentials or claim capabilities.';
