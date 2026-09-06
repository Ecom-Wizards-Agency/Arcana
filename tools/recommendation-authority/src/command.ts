import { parseBrokerResult } from '../../../docs/deploy/openspell-recommendation-authority-contract.mjs';

const REVISION = /^[0-9a-f]{40}$/u;
export type AuthorityCommand =
  | { operation: 'block'; epoch: number; oldRevision: string | null; targetRevision: string }
  | { operation: 'activate'; epoch: number; oldRevision: null; targetRevision: string }
  | { operation: 'rebind' | 'authorize'; epoch: number; oldRevision: string; targetRevision: string };

/** Exact CLI grammar. Validate before reading any credential or opening a socket. */
export function parseAuthorityCommand(args: readonly string[]): AuthorityCommand {
  const [operation, epochText, old, target] = args;
  if (args.length !== 4 || !/^(0|[1-9][0-9]{0,15})$/u.test(epochText ?? '')
    || !Number.isSafeInteger(Number(epochText)) || !REVISION.test(target ?? '')
    || (old !== '-' && !REVISION.test(old ?? ''))) throw new Error('Invalid authority command');
  const epoch = Number(epochText);
  const targetRevision = target!;
  if (operation === 'block') return { operation, epoch, oldRevision: old === '-' ? null : old!, targetRevision };
  if (operation === 'activate' && old === '-') return { operation, epoch, oldRevision: null, targetRevision };
  if ((operation === 'rebind' && old !== target && old !== '-')
    || (operation === 'authorize' && old === target)) {
    return { operation, epoch, oldRevision: old!, targetRevision };
  }
  throw new Error('Invalid authority command');
}

const SQL_KEYS = ['admission', 'authorized_revision', 'decision', 'epoch', 'protocol', 'unresolved'];
function safeCount(value: unknown): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid authority count');
  return value;
}

export function brokerResult(rows: readonly Record<string, unknown>[], operation: AuthorityCommand['operation']) {
  if (rows.length !== 1 || JSON.stringify(Object.keys(rows[0]!).sort()) !== JSON.stringify(SQL_KEYS)) {
    throw new Error('Invalid authority result count or shape');
  }
  const row = rows[0]!;
  return parseBrokerResult({
    decision: row['decision'], protocol: row['protocol'], admission: row['admission'],
    epoch: safeCount(row['epoch']), authorizedRevision: row['authorized_revision'],
    unresolved: safeCount(row['unresolved']),
  }, operation);
}
