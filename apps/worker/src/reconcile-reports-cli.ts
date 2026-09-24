import { pathToFileURL } from 'node:url';
import { Uuid } from '@wizard-ads/shared';
import {
  abandonDeadLegacyCandidates,
  connectionStringFromEnv,
  createDb,
  listQuarantinedReports,
  reconcileReport,
} from '@wizard-ads/db';

const USAGE = 'usage: reconcile-reports <list|adopt|abandon|abandon-dead> --org-id <uuid> [resolution options]';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseReconcileReportsArgs(args: readonly string[]) {
  const [action, ...rest] = args;
  if (!['list', 'adopt', 'abandon', 'abandon-dead'].includes(action ?? '')) throw new Error(USAGE);
  const values = new Map<string, string>();
  let workerStopped = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--worker-stopped' && !workerStopped) { workerStopped = true; continue; }
    if (!['--org-id', '--request-id', '--actor', '--reason', '--amazon-report-id', '--before'].includes(key)
      || values.has(key) || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error('invalid or duplicate reconciliation option');
    values.set(key, rest[++i]!);
  }
  const orgId = Uuid.parse(values.get('--org-id'));
  if (action === 'list') {
    if (values.size !== 1 || workerStopped) throw new Error('list accepts only --org-id');
    return { action: 'list' as const, orgId };
  }
  const actor = values.get('--actor')?.trim();
  const reason = values.get('--reason')?.trim();
  if (!actor || !reason || !workerStopped) throw new Error('resolution requires --actor, --reason and --worker-stopped');
  if (action === 'abandon-dead') {
    // Resolves by restatement window, never by one request: the per-request
    // commands keep their own identity and evidence checks.
    if (values.has('--request-id') || values.has('--amazon-report-id')) {
      throw new Error('abandon-dead accepts no --request-id or --amazon-report-id');
    }
    const before = values.get('--before')?.trim();
    if (!before || !ISO_DATE.test(before) || Number.isNaN(Date.parse(`${before}T00:00:00Z`))) {
      throw new Error('abandon-dead requires --before YYYY-MM-DD');
    }
    return { action: 'abandon-dead' as const, orgId, before, actor, reason, workerStopped: true as const };
  }
  if (values.has('--before')) throw new Error('--before applies only to abandon-dead');
  const requestId = Uuid.parse(values.get('--request-id'));
  const amazonReportId = values.get('--amazon-report-id')?.trim();
  if (action === 'adopt' && !amazonReportId) throw new Error('adopt requires --amazon-report-id');
  if (action === 'abandon' && amazonReportId !== undefined) throw new Error('abandon does not accept --amazon-report-id');
  return { action: action as 'adopt' | 'abandon', orgId, requestId, actor, reason, workerStopped: true as const,
    ...(amazonReportId === undefined ? {} : { amazonReportId }) };
}

export async function runReconcileReportsCli(args: readonly string[], env = process.env, write = console.log) {
  const input = parseReconcileReportsArgs(args);
  const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1, statementTimeoutSeconds: 15 });
  try {
    if (input.action === 'list') {
      const requests = await listQuarantinedReports(handle, input.orgId);
      write(JSON.stringify({ count: requests.length, requests }));
    } else if (input.action === 'abandon-dead') {
      write(JSON.stringify(await abandonDeadLegacyCandidates(handle, input)));
    } else {
      write(JSON.stringify(await reconcileReport(handle, input)));
    }
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReconcileReportsCli(process.argv.slice(2)).catch(() => {
    console.error('Report reconciliation failed. Check arguments, request evidence and database access.');
    process.exitCode = 1;
  });
}
