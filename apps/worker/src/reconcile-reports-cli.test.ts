import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseReconcileReportsArgs } from './reconcile-reports-cli.js';
const org = '11111111-1111-4111-8111-111111111111';
const request = '22222222-2222-4222-8222-222222222222';
const common = ['--org-id', org, '--request-id', request, '--actor', 'synthetic operator', '--reason', 'matched provider evidence'];
describe('report reconciliation command', () => {
  it('accepts exactly the three attended operations', () => {
    expect(parseReconcileReportsArgs(['list', '--org-id', org])).toEqual({ action: 'list', orgId: org });
    expect(parseReconcileReportsArgs(['adopt', ...common, '--worker-stopped', '--amazon-report-id', 'synthetic-report']))
      .toMatchObject({ action: 'adopt', amazonReportId: 'synthetic-report', workerStopped: true });
    expect(parseReconcileReportsArgs(['abandon', ...common, '--worker-stopped'])).toMatchObject({ action: 'abandon' });
  });
  it('refuses create, unattended resolution, missing identity and unexpected options', () => {
    for (const args of [['create'], ['adopt', ...common], ['adopt', ...common, '--worker-stopped'],
      ['abandon', ...common, '--worker-stopped', '--amazon-report-id', 'unexpected'],
      ['list', '--org-id', org, '--org-id', org]]) expect(() => parseReconcileReportsArgs(args)).toThrow();
  });
  it('has no provider dependency or report-create enqueue in its command or DB implementation', () => {
    const cli = readFileSync(new URL('./reconcile-reports-cli.ts', import.meta.url), 'utf8');
    const db = readFileSync(new URL('../../../packages/db/src/queries/report-reconciliation.ts', import.meta.url), 'utf8');
    for (const source of [cli, db]) {
      expect(source).not.toMatch(/from ['"][^'"]*(?:ads-api|worker)[^'"]*['"]/);
      expect(source).not.toMatch(/type:\s*['"]report\.request['"]/);
    }
  });
});
