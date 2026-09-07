import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createDb } from './client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
describe.skipIf(!available)('transaction scope after database connection loss', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('transaction_disconnect');
    await database.sql`create table public.synthetic_transaction_probe(id integer primary key)`;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  it.each(['transaction', 'savepoint', 'failed-savepoint'] as const)(
    '%s refuses its closed scope while independent requests reuse the pool', async (mode) => {
      const pool = createDb({ connectionString: database.connectionString, max: 1 });
      let closedScope!: postgres.TransactionSql;
      let failed!: () => void; let release!: () => void;
      const ready = new Promise<void>((resolve) => { failed = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      try {
        const [backend] = await pool.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const body = async (sql: postgres.TransactionSql) => {
          closedScope = sql;
          if (mode === 'failed-savepoint') {
            try { await sql`select 1/0`; }
            catch (error) { failed(); await hold; throw error; }
          } else await sql`select pg_sleep(10)`;
        };
        const operation = pool.sql.begin(async (sql) => mode === 'transaction' ? body(sql) : sql.savepoint(body));
        const outcome = operation.then(() => null, (error: unknown) => error);
        if (mode === 'failed-savepoint') await ready;
        else {
          let observed = false;
          for (let i = 0; i < 200; i++) {
            const rows = await database.sql`select pid from pg_stat_activity where pid=${backend!.pid}
              and datname=current_database() and wait_event='PgSleep'`;
            if (rows.length === 1) { observed = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(observed).toBe(true);
        }
        // This request belongs to the pool, not the transaction being lost.
        const pending = pool.sql`select 41::int as value`.execute();
        const pendingOutcome = pending.then((rows) => rows, (error: unknown) => error);
        const [owned] = await database.sql<{ owned: boolean }[]>`select datname=current_database() as owned
          from pg_stat_activity where pid=${backend!.pid}`;
        expect(owned?.owned).toBe(true);
        expect(await database.sql`select pg_terminate_backend(${backend!.pid}) as terminated`).toEqual([{ terminated: true }]);
        release();
        expect(await outcome).toMatchObject({ code: 'CONNECTION_CLOSED' });
        expect(await pendingOutcome).toEqual([{ value: 41 }]);
        expect(await pool.sql`select 42::int as value`).toEqual([{ value: 42 }]);
        const id = ['transaction', 'savepoint', 'failed-savepoint'].indexOf(mode) + 1;
        await pool.sql.begin(async (sql) => {
          await sql`insert into public.synthetic_transaction_probe(id) values(${id})`;
          // Late cleanup/work from an earlier transaction cannot run here.
          await expect(closedScope`delete from public.synthetic_transaction_probe`).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
          expect(await sql`select id from public.synthetic_transaction_probe where id=${id}`).toEqual([{ id }]);
        });
        expect(await database.sql`select id from public.synthetic_transaction_probe where id=${id}`).toEqual([{ id }]);
      } finally { release(); await pool.close(); }
    },
  );
});

// Disabling type discovery matters here: its own successful CommandComplete
// would otherwise reset a stale DataRow index and hide the reconnect defect.
describe.skipIf(!available)('partial result state after connection loss', () => {
  it('starts the replacement connection with an empty result and zero row index', async () => {
    const { default: postgres } = await import('postgres');
    const database = await createTestDatabase('partial_disconnect');
    let received = 0;
    const pool = postgres(database.connectionString, {
      max: 1, prepare: false, fetch_types: false, onnotice: () => {},
      transform: { row: { from: (row) => { if ('probe_row' in row) received++; return row; } } },
    });
    try {
      const [backend] = await pool<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const pending = pool.begin(async (sql) => {
        await sql`select i as probe_row, repeat('x',1000) as padding,
          case when i=500 then pg_sleep(10) end from generate_series(1,500) as i`;
      }).then(() => null, (error: unknown) => error);
      let sleeping = false;
      for (let i = 0; i < 400; i++) {
        const rows = await database.sql`select pid from pg_stat_activity where pid=${backend!.pid}
          and datname=current_database() and wait_event='PgSleep'`;
        if (rows.length === 1 && received > 0) { sleeping = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(sleeping).toBe(true);
      expect(received).toBeGreaterThan(0); expect(received).toBeLessThan(500);
      expect(await database.sql`select pg_terminate_backend(${backend!.pid}) as terminated`).toEqual([{ terminated: true }]);
      expect(await pending).toMatchObject({ code: 'CONNECTION_CLOSED' });
      const result = await pool`select 1::int as healthy`;
      expect(result).toEqual([{ healthy: 1 }]);
      expect(Object.keys(result)).toEqual(['0']);
    } finally { await pool.end({ timeout: 1 }); await database.drop(); }
  }, 60_000);
});
