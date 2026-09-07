import { AmazonConnectionClaim, AmazonConnectionOperation, AmazonConnectionReason,
  AmazonConnectionRegionProgress, AmazonConnectionRosterInput, Region, Uuid } from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';

/** Query errors may retain code/token bindings; none crosses the worker boundary. */
export class AmazonConnectionCommandError extends Error {
  constructor() {
    super('Amazon connection command could not be completed');
    this.name = 'AmazonConnectionCommandError';
  }
}

async function command<T>(handle: Pick<DbHandle, 'sql'>, run: (sql: QuerySql) => Promise<T>): Promise<T> {
  try {
    const result = await handle.sql.begin(async (sql) => {
      await sql`set local statement_timeout = '10s'`;
      await sql`set local lock_timeout = '3s'`;
      return { value: await run(sql) };
    });
    return result.value;
  } catch {
    throw new AmazonConnectionCommandError();
  }
}

function operation(rows: { result: unknown }[]): AmazonConnectionOperation {
  if (rows.length !== 1) throw new AmazonConnectionCommandError();
  return AmazonConnectionOperation.parse(rows[0]!.result);
}

/** Never retry a claim after uncertain output: an exchange code is returned once. */
export async function claimAmazonConnection(
  handle: Pick<DbHandle, 'sql'>, leaseId: string,
): Promise<AmazonConnectionClaim | null> {
  const id = Uuid.parse(leaseId);
  return command(handle, async (sql) => {
    const rows = await sql<{ result: unknown }[]>`select app.claim_amazon_connection(${id}) as result`;
    if (rows.length !== 1) throw new AmazonConnectionCommandError();
    return rows[0]!.result === null ? null : AmazonConnectionClaim.parse(rows[0]!.result);
  });
}

export async function attachAmazonConnectionGrant(
  handle: Pick<DbHandle, 'sql'>, operationId: string, leaseId: string, refreshToken: string,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId); const lease = Uuid.parse(leaseId);
  if (refreshToken.length < 1 || refreshToken.length > 65_536) throw new AmazonConnectionCommandError();
  return command(handle, async (sql) => operation(await sql<{ result: unknown }[]>`
    select app.attach_amazon_connection_grant(${id}, ${lease}, ${refreshToken}) as result
  `));
}

export async function failAmazonConnectionExchange(
  handle: Pick<DbHandle, 'sql'>, operationId: string, leaseId: string,
  reason: Extract<AmazonConnectionReason, 'exchange_refused' | 'exchange_uncertain' | 'installation_changed'>,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId); const lease = Uuid.parse(leaseId);
  const outcome = AmazonConnectionReason.extract(['exchange_refused', 'exchange_uncertain', 'installation_changed']).parse(reason);
  return command(handle, async (sql) => operation(await sql<{ result: unknown }[]>`
    select app.fail_amazon_connection_exchange(${id}, ${lease}, ${outcome}) as result
  `));
}

/** Waits behind an attaching transaction to reconcile an uncertain COMMIT. */
export async function readAmazonConnectionWorker(
  handle: Pick<DbHandle, 'sql'>, operationId: string,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId);
  return command(handle, async (sql) => operation(await sql<{ result: unknown }[]>`
    select app.read_amazon_connection_worker(${id}) as result
  `));
}

/** A changed installation can stop only its currently owned discovery claim. */
export async function failAmazonConnectionDiscovery(
  handle: Pick<DbHandle, 'sql'>, operationId: string, leaseId: string,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId); const lease = Uuid.parse(leaseId);
  return command(handle, async (sql) => operation(await sql<{ result: unknown }[]>`
    select app.fail_amazon_connection_discovery(${id}, ${lease}) as result
  `));
}

export async function startAmazonConnectionRegion(
  handle: Pick<DbHandle, 'sql'>, operationId: string, leaseId: string, region: Region,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId); const lease = Uuid.parse(leaseId); const host = Region.parse(region);
  return command(handle, async (sql) => operation(await sql<{ result: unknown }[]>`
    select app.start_amazon_connection_region(${id}, ${lease}, ${host}::public.ads_region) as result
  `));
}

/** A region commits its roster, exact counts and retry receipt together. */
export async function recordAmazonConnectionRegion(
  handle: Pick<DbHandle, 'sql'>, operationId: string, leaseId: string, region: Region,
  input: AmazonConnectionRosterInput | null, failure: NonNullable<AmazonConnectionRegionProgress['reason']> | null,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId); const lease = Uuid.parse(leaseId); const host = Region.parse(region);
  const counted = input === null ? null : JSON.stringify(AmazonConnectionRosterInput.parse(input));
  const reason = AmazonConnectionRegionProgress.shape.reason.parse(failure);
  return command(handle, async (sql) => operation(await sql<{ result: unknown }[]>`
    select app.record_amazon_connection_region(${id}, ${lease}, ${host}::public.ads_region,
      ${counted}::jsonb, ${reason}) as result
  `));
}
