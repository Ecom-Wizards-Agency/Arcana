// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StreamConsumerEvidence, StreamExtensionEvent } from '@wizard-ads/shared';
import { StreamEvidencePanel } from './stream-evidence';
const event = StreamExtensionEvent.parse({orgId:'00000000-0000-4000-8000-000000000001',profileId:'00000000-0000-4000-8000-000000000002',identity:'a'.repeat(64),payloadFingerprint:'b'.repeat(64),receivedAt:'2026-09-15T12:00:00.000Z',record:{contractVersion:'fixture.v1',datasetId:'sb-clickstream',subscriptionId:'sub',advertiserId:'advertiser',marketplaceId:'market',region:'EU',destinationArn:'arn:aws:sqs:eu-west-1:000000000000:synthetic',eventId:'event',revision:1,eventTime:'2026-09-15T12:00:00.000Z',window:{start:'2026-09-15T11:00:00.000Z',end:'2026-09-15T12:00:00.000Z'},observation:{campaignId:'campaign',creativeId:'creative',clicks:0}}});
it('renders a measured zero only from an explicit source field; no invented engagement or report totals',()=>{
  render(<StreamEvidencePanel evidence={StreamConsumerEvidence.parse({events:[event],measured:1,unresolved:2,completeness:'partial',source:'amazon_marketing_stream',mutationAuthority:false})}/>);
  expect(screen.getByText('Clicks: 0')).toBeTruthy();
  expect(screen.queryByText('Engagements: 0')).toBeNull();
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  expect(screen.getByText(/1 measured observations · 2 unresolved/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
it('distinguishes missing and stale evidence without refreshing its source timestamp',()=>{
  const {rerender}=render(<StreamEvidencePanel evidence={{associations:[],staleEventIds:[],excluded:0,truncated:false,events:[],measured:0,unresolved:1,completeness:'missing',source:'amazon_marketing_stream',mutationAuthority:false}}/>);
  expect(screen.getByText(/Not measured/)).toBeTruthy();expect(screen.queryByRole('table')).toBeNull();
  rerender(<StreamEvidencePanel evidence={{associations:[],staleEventIds:[],excluded:0,truncated:false,events:[event],measured:1,unresolved:0,completeness:'stale',source:'amazon_marketing_stream',mutationAuthority:false}}/>);
  expect(screen.getByText(/stale/)).toBeTruthy();expect(screen.getByText('2026-09-15T12:00:00.000Z')).toBeTruthy();
});
