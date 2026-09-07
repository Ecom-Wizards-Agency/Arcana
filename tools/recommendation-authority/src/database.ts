import postgres from 'postgres';
import { brokerResult, type AuthorityCommand } from './command.js';
import { validateAuthorityDatabaseUrl } from './credential.js';
import { recommendationDatabaseTls } from '../../../docs/deploy/openspell-recommendation-database-trust.mjs';

export function connectAuthority(databaseUrl: string) {
  const credential = validateAuthorityDatabaseUrl(databaseUrl);
  const ssl = recommendationDatabaseTls(credential);
  return postgres(credential, {
    ...(ssl === undefined ? {} : { ssl }),
    max: 1, prepare: false, connect_timeout: 5, idle_timeout: 1, max_lifetime: 30,
    onnotice: () => {}, debug: false,
    connection: { application_name: 'openspell-recommendation-authority', statement_timeout: 5000, lock_timeout: 3000 },
  });
}
export type AuthorityConnection = ReturnType<typeof connectAuthority>;

/** One CAS statement, one transaction, no retry; only a confirmed COMMIT returns. */
export async function executeAuthority(sql: AuthorityConnection, command: AuthorityCommand) {
  return sql.begin(async (transaction) => {
    await transaction`set local role service_role`;
    await transaction`select set_config('request.jwt.claims', '{"role":"service_role"}', true),
      set_config('request.jwt.claim.role', 'service_role', true)`;
    let rows;
    switch (command.operation) {
      case 'block':
        rows = await transaction`select * from public.block_recommendation_admission(${command.epoch}::bigint)`;
        break;
      case 'activate':
        rows = await transaction`select * from public.activate_recommendation_fenced_claims(${command.epoch}::bigint,${command.targetRevision}::text)`;
        break;
      case 'rebind':
        rows = await transaction`select * from public.rebind_recommendation_fenced_revision(${command.epoch}::bigint,${command.oldRevision}::text,${command.targetRevision}::text)`;
        break;
      case 'authorize':
        rows = await transaction`select * from public.authorize_recommendation_scoped_admission(${command.epoch}::bigint,${command.targetRevision}::text)`;
        break;
    }
    return brokerResult(rows, command.operation);
  });
}
