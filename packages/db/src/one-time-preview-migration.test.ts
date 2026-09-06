import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { applySqlFile, createTestDatabase, databaseAvailable } from './testing/index.js';

const available = await databaseAvailable();
it.skipIf(!available)('adds one-time snapshots without altering historical rows, custody activation, or RPC owners/grants', async () => {
  const database = await createTestDatabase('one_time_upgrade', { throughMigration: '20260901060000_recommendation_claim_custody.sql' });
  try {
    await database.sql`select app.seed_tenant_fixture('one-time-upgrade', 'abababab-abab-4bab-8bab-abababababab'::uuid, 'owner')`;
    const snapshot = async () => {
      const [rows] = await database.sql<{
        runs: unknown; batches: unknown; jobs: unknown; authority: unknown; functions: unknown;
      }[]>`
        select
          (select jsonb_agg(to_jsonb(run) - 'execution_snapshot' order by run.id) from public.recommendation_runs run) as runs,
          (select jsonb_agg(to_jsonb(batch) - 'execution_snapshot' order by batch.id) from public.recommendation_preview_batches batch) as batches,
          (select jsonb_agg(to_jsonb(job) order by job.id) from public.sync_jobs job) as jobs,
          (select to_jsonb(authority) from app.recommendation_claim_authority authority) as authority,
          (select jsonb_agg(jsonb_build_object('oid', proc.oid, 'owner', proc.proowner, 'acl', proc.proacl) order by proc.oid)
            from pg_proc proc where proc.oid in (
              'app.recommendation_job_scope_closes(uuid)'::regprocedure,
              'public.start_recommendation_run_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid)'::regprocedure,
              'public.read_recommendation_inputs_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid,date,date)'::regprocedure,
              'public.succeed_recommendation_run_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid,jsonb)'::regprocedure
            )) as functions
      `;
      return rows;
    };
    const before = await snapshot();
    expect(before?.runs).not.toEqual([]);
    await applySqlFile(database, fileURLToPath(new URL('../../../supabase/migrations/20260907000000_one_time_rpc_previews.sql', import.meta.url)));
    expect(await snapshot()).toEqual(before);
    const [state] = await database.sql<{ execution_snapshots: number; protocol: string; admission: string }[]>`
      select (select count(*)::integer from public.recommendation_runs where execution_snapshot is not null) as execution_snapshots,
        protocol, admission from app.recommendation_claim_authority where singleton
    `;
    expect(state).toEqual({ execution_snapshots: 0, protocol: 'legacy', admission: 'legacy' });
  } finally { await database.drop(); }
}, 60_000);
