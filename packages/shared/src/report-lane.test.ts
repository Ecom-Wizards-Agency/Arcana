import { describe, expect, it } from 'vitest';
import {
  ReportLaneErrorClass,
  ReportLaneStage,
  ReportLaneStatus,
  classifyReportLaneFailure,
  reportLaneBlockingStage,
  type ReportLaneJobType,
  type ReportLaneStageStatus,
} from './reporting.js';

describe('report lane failure classification', () => {
  // Every message is one the worker records verbatim (WP-323 and earlier).
  const cases: readonly [ReportLaneJobType, string, string, string, boolean][] = [
    ['report.fetch', 'report download exceeded decompressed_bytes limit', 'fetch', 'download_inflate_limit', true],
    ['report.fetch', 'report download exceeded compressed_bytes limit', 'fetch', 'download_compressed_limit', false],
    ['report.fetch', 'report download exceeded parsed_row_bytes limit', 'fetch', 'parser_limit', false],
    ['report.fetch', 'report download exceeded parsed_rows limit', 'fetch', 'parser_limit', false],
    ['report.fetch', 'report download exceeded parsed_bytes limit', 'fetch', 'parser_limit', false],
    ['report.fetch', 'report download exceeded idle_timeout limit', 'fetch', 'download_timeout', true],
    ['report.fetch', 'report download exceeded total_timeout limit', 'fetch', 'download_timeout', true],
    ['report.fetch', 'report download URL expired', 'fetch', 'download_url_expired', true],
    ['report.fetch', 'report download URL expired; the stored report is gone', 'fetch', 'download_url_expired', true],
    ['report.fetch', 'report download URL remained expired beyond the 4-hour request horizon', 'fetch', 'download_url_expired', true],
    ['report.fetch', 'report download URL expired after 3 re-requests of this window', 'fetch', 'download_url_expired', true],
    ['report.fetch', 'report download URL was rejected by report storage', 'fetch', 'download_url_rejected', true],
    ['report.fetch', 'report download failed with 503', 'fetch', 'download_transport', true],
    ['report.fetch', 'report payload gzip stream is corrupt or truncated', 'fetch', 'payload_corrupt', true],
    ['report.fetch', 'report payload is neither gzip nor JSON', 'fetch', 'payload_format', false],
    ['report.fetch', 'report payload is empty', 'fetch', 'payload_format', false],
    ['report.fetch', 'report payload is not valid JSON', 'fetch', 'payload_format', false],
    ['report.fetch', 'report payload must be a JSON array', 'fetch', 'payload_format', false],
    ['report.fetch', 'Failed query: insert into fact_search_term_daily (synthetic)', 'load', 'load_failed', false],
    ['report.fetch', 'targetId must be a non-empty string', 'load', 'parser_refused_rows', false],
    ['report.fetch', 'spTargeting replacement parser refused 2 of 9 rows: missing keywordId (2)', 'load', 'parser_refused_rows', false],
    ['report.fetch', 'report parsed 9 rows but loaded 8', 'load', 'count_mismatch', false],
    ['report.request', 'Reporting v3 create outcome is unknown after transport', 'request', 'create_outcome_unknown', false],
    ['report.request', 'Failed query: insert into report_requests (synthetic)', 'request', 'store_failed', false],
    ['report.request', 'Amazon answered 429 Too Many Requests', 'request', 'provider_throttled', false],
    ['report.poll', 'completed report synthetic-report has no download URL', 'poll', 'report_failed', false],
    ['report.poll', 'upstream answered 503', 'poll', 'provider_unavailable', false],
    ['report.poll', 'report lifecycle stopped after exhausting its retry budget', 'poll', 'retry_budget_exhausted', false],
    ['report.fetch', 'something nobody anticipated', 'fetch', 'unclassified', false],
  ];

  it.each(cases)('%s "%s" is %s / %s (re-requestable: %s)', (jobType, message, stage, errorClass, recoverable) => {
    expect(classifyReportLaneFailure(jobType, message)).toEqual({ stage, errorClass, recoverableByReRequest: recoverable });
  });

  it('names parser limits separately from the inflate limit', () => {
    const parser = ['parsed_row_bytes', 'parsed_rows', 'parsed_bytes']
      .map((kind) => classifyReportLaneFailure('report.fetch', `report download exceeded ${kind} limit`).errorClass);
    expect(new Set(parser)).toEqual(new Set(['parser_limit']));
    expect(classifyReportLaneFailure('report.fetch', 'report download exceeded decompressed_bytes limit').errorClass)
      .toBe('download_inflate_limit');
  });

  it('never marks a request or poll failure re-requestable and never puts one in the load stage', () => {
    for (const jobType of ['report.request', 'report.poll'] as const) {
      for (const [, message] of cases) {
        const failure = classifyReportLaneFailure(jobType, message);
        expect(failure.recoverableByReRequest).toBe(false);
        expect(failure.stage).toBe(jobType === 'report.request' ? 'request' : 'poll');
      }
    }
  });

  it('only produces declared classes, and treats a missing message as unclassified', () => {
    expect(classifyReportLaneFailure('report.fetch', null)).toEqual({ stage: 'fetch', errorClass: 'unclassified', recoverableByReRequest: false });
    for (const [jobType, message] of cases) {
      expect(ReportLaneErrorClass.options).toContain(classifyReportLaneFailure(jobType, message).errorClass);
    }
  });
});

describe('report lane blocking stage', () => {
  const stage = (name: ReportLaneStageStatus['stage'], values: Partial<ReportLaneStageStatus> = {}): ReportLaneStageStatus => ({
    stage: name, lastSucceededAt: null, lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0, ...values,
  });

  it('names the production shape: requests and polls work, fetch fails after its last success', () => {
    const stages = [
      stage('request', { lastSucceededAt: '2026-09-24T07:34:00.000Z', lastFailedAt: '2026-09-15T09:00:00.000Z', lastErrorClass: 'create_outcome_unknown', dead: 1112 }),
      stage('poll', { lastSucceededAt: '2026-09-24T07:40:00.000Z' }),
      stage('fetch', { lastSucceededAt: '2026-09-20T06:00:00.000Z', lastFailedAt: '2026-09-24T07:45:00.000Z', lastErrorClass: 'download_inflate_limit', dead: 762 }),
      stage('load', { lastSucceededAt: '2026-09-20T06:00:00.000Z', lastFailedAt: '2026-08-27T05:00:00.000Z', lastErrorClass: 'load_failed', dead: 56 }),
    ];
    expect(reportLaneBlockingStage(stages)).toEqual({
      stage: 'fetch', errorClass: 'download_inflate_limit',
      since: '2026-09-24T07:45:00.000Z', lastSucceededAt: '2026-09-20T06:00:00.000Z',
    });
  });

  it.each(ReportLaneStage.options)('blocks at %s when it failed and never succeeded', (name) => {
    const stages = ReportLaneStage.options.map((candidate) => candidate === name
      ? stage(candidate, { lastFailedAt: '2026-09-24T00:00:00.000Z', lastErrorClass: 'unclassified' })
      : stage(candidate, { lastSucceededAt: '2026-09-24T01:00:00.000Z' }));
    expect(reportLaneBlockingStage(stages)?.stage).toBe(name);
  });

  it('prefers the earliest blocked stage and clears when every stage succeeded after it failed', () => {
    const blocked = ReportLaneStage.options.map((name) => stage(name, {
      lastSucceededAt: '2026-09-23T00:00:00.000Z', lastFailedAt: '2026-09-24T00:00:00.000Z', lastErrorClass: 'unclassified',
    }));
    expect(reportLaneBlockingStage(blocked)?.stage).toBe('request');
    const recovered = blocked.map((row) => ({ ...row, lastSucceededAt: '2026-09-24T00:00:00.000Z' }));
    expect(reportLaneBlockingStage(recovered)).toBeNull();
  });

  it('requires all four stages in the status contract', () => {
    const base = {
      scope: 'organisation', blocking: null, profiles: [],
      organisationDead: { total: 0, byStage: { request: 0, poll: 0, fetch: 0, load: 0 }, reRequested: 0, resolved: 0 },
    };
    expect(ReportLaneStatus.safeParse({ ...base, stages: ReportLaneStage.options.map((name) => stage(name)) }).success).toBe(true);
    expect(ReportLaneStatus.safeParse({ ...base, stages: [stage('fetch')] }).success).toBe(false);
  });
});
