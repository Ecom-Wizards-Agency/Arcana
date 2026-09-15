import {
  AmazonConnectionBegin, AmazonConnectionOperation, AmazonConnectionSubmit,
  Uuid, type OrgActor,
} from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';
import { withAuthenticatedActor } from './authenticated-actor.js';

type Handle = Pick<DbHandle, 'sql'>;

/** Keep only fixed diagnostics; postgres.js errors can retain bound credentials. */
export class AmazonConsentStoreError extends Error {
  readonly code: string | undefined;
  constructor(sqlState?: string) {
    super('Amazon consent could not be saved');
    this.name = 'AmazonConsentStoreError';
    this.code = sqlState !== undefined
      && ['42501', '22023', '23505', '40001', '40P01', '55P03', '57014'].includes(sqlState)
      ? sqlState : undefined;
  }
}

function operationResponse(rows: { operation: unknown }[]): AmazonConnectionOperation {
  if (rows.length !== 1) throw new Error('Connection response count mismatch');
  return AmazonConnectionOperation.parse(rows[0]!.operation);
}

/** Saved installation values come from server configuration, never callback parameters. */
export async function beginAmazonConnection(
  handle: Handle, actor: OrgActor, raw: AmazonConnectionBegin,
): Promise<AmazonConnectionOperation> {
  const input = AmazonConnectionBegin.parse(raw);
  return withAuthenticatedActor(handle, actor, async (sql) => operationResponse(await sql<{ operation: unknown }[]>`
    select app.begin_amazon_connection(${actor.orgId}, ${input.requestId}, ${input.nonceHash},
      ${input.clientId}, ${input.redirectUri}, ${input.scope}) as operation
  `));
}

/** The transient code is bound directly to encrypted custody, never a job or log. */
export async function submitAmazonConnection(
  handle: Handle, actor: OrgActor, raw: AmazonConnectionSubmit,
): Promise<AmazonConnectionOperation> {
  const input = AmazonConnectionSubmit.parse(raw);
  try {
    return await withAuthenticatedActor(handle, actor, async (sql) => operationResponse(await sql<{ operation: unknown }[]>`
      select app.submit_amazon_connection(${actor.orgId}, ${input.operationId}, ${input.nonceHash}, ${input.code}) as operation
    `));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : undefined;
    throw new AmazonConsentStoreError(code);
  }
}

export async function cancelAmazonConnection(
  handle: Handle, actor: OrgActor, operationId: string,
): Promise<AmazonConnectionOperation> {
  const id = Uuid.parse(operationId);
  return withAuthenticatedActor(handle, actor, async (sql) => operationResponse(await sql<{ operation: unknown }[]>`
    select app.cancel_amazon_connection(${actor.orgId}, ${id}) as operation
  `));
}

/** No organization fallback, privileged select or internal custody fields. */
export async function readAmazonConnection(
  handle: Handle, actor: OrgActor, operationId: string,
): Promise<AmazonConnectionOperation | null> {
  const id = Uuid.parse(operationId);
  return withAuthenticatedActor(handle, actor, async (sql: QuerySql) => {
    const rows = await sql<{ operation: unknown }[]>`select app.read_amazon_connection(${actor.orgId}, ${id}) as operation`;
    if (rows.length !== 1) throw new Error('Connection read response count mismatch');
    return rows[0]!.operation === null ? null : AmazonConnectionOperation.parse(rows[0]!.operation);
  });
}

/** Settings can resume the last operation without retaining its identifier in a browser. */
export async function latestAmazonConnection(
  handle: Handle, actor: OrgActor,
): Promise<AmazonConnectionOperation | null> {
  return withAuthenticatedActor(handle, actor, async (sql: QuerySql) => {
    const rows = await sql<{ operation: unknown }[]>`select app.latest_amazon_connection(${actor.orgId}) as operation`;
    if (rows.length !== 1) throw new Error('Connection read response count mismatch');
    return rows[0]!.operation === null ? null : AmazonConnectionOperation.parse(rows[0]!.operation);
  });
}
