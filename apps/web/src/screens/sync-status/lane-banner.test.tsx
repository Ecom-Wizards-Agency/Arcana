// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ReportLaneErrorClass, type ReportLaneStatus } from '@wizard-ads/shared';
import { formatTimestamp } from '../../ui/date-format';
import { rendered } from '../render-test-support';
import { REPORT_LANE_ERROR_LABELS, ReportLaneBanner } from './lane-banner';

const stage = (name: ReportLaneStatus['stages'][number]['stage']) => ({
  stage: name, lastSucceededAt: null, lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0,
});
const base: ReportLaneStatus = {
  scope: 'profile',
  stages: [stage('request'), stage('poll'), { ...stage('fetch'), lastFailedAt: '2026-09-24T10:10:00.000Z', lastErrorClass: 'download_url_expired', dead: 17 }, stage('load')],
  blocking: { stage: 'fetch', errorClass: 'download_url_expired', since: '2026-09-24T10:10:00.000Z', lastSucceededAt: null },
  organisationDead: { total: 20, byStage: { request: 2, poll: 1, fetch: 17, load: 0 }, reRequested: 12, resolved: 2 },
  profiles: [],
};

describe('report lane banner', () => {
  it('names the stage, its bounded class and the newest fact date, and says never for a stage that never succeeded', () => {
    const host = rendered(<ReportLaneBanner lane={base} factDates={['2026-08-27', null, '2026-08-28']} />);
    const banner = host.querySelector('[data-testid="report-lane-blocking"]');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('Reports are blocked at the fetch stage (downloading and parsing it).');
    expect(host.querySelector('[data-testid="report-lane-error-class"]')?.textContent).toBe('download_url_expired');
    expect(banner?.textContent).toContain('The fetch stage last succeeded never.');
    expect(banner?.textContent).toContain('Newest facts: 28 Aug 2026.');
  });

  it('counts the organisation-wide dead jobs with their own label, apart from the scoped stage table', () => {
    const host = rendered(<ReportLaneBanner lane={base} factDates={[]} />);
    expect(host.querySelector('[data-testid="report-lane-dead"]')?.textContent?.replace(/\s+/g, ' ')).toBe(
      'Dead report jobs across the organisation: 20 (request 2, poll 1, fetch 17, load 0). Of these, 12 were re-requested automatically and 2 were resolved through reconciliation.',
    );
    expect(host.querySelector('caption')?.textContent).toBe('Report stages for the selected profile');
    const rows = [...host.querySelectorAll('[data-testid="report-lane-stage"]')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['request', 'never', 'no failure recorded', '—', '0', '0'],
      ['poll', 'never', 'no failure recorded', '—', '0', '0'],
      ['fetch', 'never', formatTimestamp('2026-09-24T10:10:00.000Z'), 'download_url_expired', '0', '17'],
      ['load', 'never', 'no failure recorded', '—', '0', '0'],
    ]);
    expect(host.querySelector('[data-testid="report-lane-blocking"]')).not.toBeNull();
  });

  it('reports a clear lane without an alert and gives every error class an operator label', () => {
    const host = rendered(<ReportLaneBanner lane={{ ...base, scope: 'organisation', blocking: null }} factDates={[null]} />);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-testid="report-lane-clear"]')?.textContent).toContain('No report stage is blocked for every profile');
    for (const errorClass of ReportLaneErrorClass.options) expect(REPORT_LANE_ERROR_LABELS[errorClass].length).toBeGreaterThan(10);
  });
});
