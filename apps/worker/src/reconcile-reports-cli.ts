import { pathToFileURL } from 'node:url';
import { Uuid } from '@wizard-ads/shared';
import { connectionStringFromEnv, createDb, listQuarantinedReports, reconcileReport } from '@wizard-ads/db';

export function parseReconcileReportsArgs(args: readonly string[]) {
  const [action, ...rest] = args;
  if (!['list', 'adopt', 'abandon'].includes(action ?? '')) throw new Error('usage: reconcile-reports <list|adopt|abandon> --org-id <uuid> [resolution options]');
  const values = new Map<string, string>();
  let workerStopped = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--worker-stopped' && !workerStopped) { workerStopped = true; continue; }
    if (!['--org-id', '--request-id', '--actor', '--reason', '--amazon-report-id'].includes(key)
      || values.has(key) || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error('invalid or duplicate reconciliation option');
    values.set(key, rest[++i]!);
  }
  const orgId = Uuid.parse(values.get('--org-id'));
  if (action === 'list') {
    if (values.size !== 1 || workerStopped) throw new Error('list accepts only --org-id');
    return { action: 'list' as const, orgId };
  }
  const requestId = Uuid.parse(values.get('--request-id'));
  const actor = values.get('--actor')?.trim();
  const reason = values.get('--reason')?.trim();
  const amazonReportId = values.get('--amazon-report-id')?.trim();
  if (!actor || !reason || !workerStopped) throw new Error('resolution requires --actor, --reason and --worker-stopped');
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
