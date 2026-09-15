// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ProviderDiagnostics } from './provider-diagnostics';
it('shows missing provider evidence without offering approval', () => {
  render(<ProviderDiagnostics />);
  expect(screen.getByText('No campaign diagnostics have been projected.')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText(/carry no approval authority/)).toBeTruthy();
});
it('retains stale source time and counts displayed diagnostics separately from proposals', () => {
  const at = '2026-09-01T00:00:00.000Z';
  render(<ProviderDiagnostics evidence={{ count: 1, source: 'amazon_marketing_stream', completeness: 'stale', selectionAuthority: false,
    events: [{ orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002',
      identity: 'a'.repeat(64), payloadFingerprint: 'b'.repeat(64), receivedAt: at, record: {
        contractVersion: 'fixture.v1', datasetId: 'sponsored-ads-campaign-diagnostics-recommendations', subscriptionId: 'sub', advertiserId: 'advertiser', marketplaceId: 'market', region: 'EU', destinationArn: 'arn:aws:sqs:eu-west-1:000000000000:synthetic', eventId: 'event', revision: 1, eventTime: at, window: null,
        observation: { campaignId: 'campaign', recommendationId: 'rec', diagnosticCode: 'budget', severity: 'warning' },
      } }] }} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText(/stale evidence/)).toBeTruthy();
  expect(screen.getByText(at).getAttribute('datetime')).toBe(at);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
