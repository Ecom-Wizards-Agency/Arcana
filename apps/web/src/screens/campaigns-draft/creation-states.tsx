'use client';
import { orderCampaignCreationNodes, CAMPAIGN_CREATION_UNAVAILABLE, CampaignBuilderCheck, type CampaignBuilderResult } from '@wizard-ads/shared';
import type { CampaignCreationApprovalView } from '@wizard-ads/shared/campaign-creation-approval';
import { Button, CampaignPage, DetailsTable, Notice, NO_ROLLBACK_NOTE } from '../campaigns/ui';

export type CreationExecutor = { available: false } | { available: true; create: () => void; retry: () => void };
export function CreationConfirm({ review, checks, executor, onExport, onBack }: {
  review: CampaignCreationApprovalView; checks: CampaignBuilderCheck[]; executor: CreationExecutor; onExport: () => void; onBack: () => void;
}) {
  const nodes = orderCampaignCreationNodes(review.plan.nodes).filter((node) => node.effect === 'irreversible_create');
  const count = review.plan.counts.byKind['campaign.create'];
  const currency = review.plan.nodes.find((node) => node.kind === 'campaign.create')?.payload.budget.currencyCode ?? '';
  const completeChecks = CampaignBuilderCheck.shape.id.options.every((id) => checks.filter((check) => check.id === id).length === 1);
  const available = executor.available && completeChecks && !checks.some((check) => check.blocking) && review.freshness.status === 'current';
  const labels = { 'campaign.create': 'Campaign', 'ad_group.create': 'Ad group', 'ad.create': 'Product ad', 'target.create': 'Keyword', 'creative.create': 'Creative' };
  return <CampaignPage title="Confirm campaign creation"><Notice><strong>Create {count} campaign(s) in Amazon</strong><p>{review.profile.label} · {review.plan.marketplaceId} · {currency} · Campaign starts paused</p></Notice>
    <DetailsTable headings={['Resource', 'Count', 'After creation']} rows={nodes.map((node) => [labels[node.kind as keyof typeof labels] ?? node.kind, 1, node.kind === 'campaign.create' ? 'Paused' : node.kind === 'target.create' ? 'Using the reviewed bid' : 'In the reviewed campaign'])} />
    <p>{nodes.length} resources will be created in order. Validation must pass for the exact draft you approve.</p><p>Payload fingerprint <code>{review.plan.fingerprint}</code></p>
    <Notice kind="warn">{NO_ROLLBACK_NOTE}</Notice>
    {checks.some((check) => check.status === 'not_measured') && <Notice><strong>Checks not measured</strong><ul>{checks.filter((check) => check.status === 'not_measured').map((check) => <li key={check.id}>{check.label} · {check.source}</li>)}</ul></Notice>}
    {!executor.available && <Notice>{CAMPAIGN_CREATION_UNAVAILABLE}</Notice>}
    {executor.available && !available && <Notice kind="warn">The current approval evidence is unavailable or stale. Review this draft again.</Notice>}
    <div className="wa-actions"><Button onClick={onBack}>Back to draft</Button><Button variant="primary" disabled={!available} onClick={() => { if (available && executor.available) executor.create(); }}>Yes, create {count} {count === 1 ? 'campaign' : 'campaigns'} in Amazon</Button><Button onClick={onExport}>Export bulk sheet</Button></div>
  </CampaignPage>;
}
function keywordRetryCount(result: CampaignBuilderResult): number {
  const accounting = result.snapshot.accounting;
  const parents = result.resources.filter((row) => row.kind !== 'keyword');
  if (!parents.some((row) => row.kind === 'campaign') || !parents.some((row) => row.kind === 'ad_group') || !parents.some((row) => row.kind === 'product_ad')
    || parents.some((row) => row.status !== 'created') || accounting.observed !== accounting.succeeded
    || result.resources.some((row) => row.status !== 'created' && !(row.kind === 'keyword' && row.status === 'failed'))) return 0;
  return result.resources.filter((row) => row.kind === 'keyword' && row.status === 'failed').reduce((sum, row) => sum + row.requested - row.succeeded, 0);
}
export function CreationResult({ result, onRetry, onBack }: { result: CampaignBuilderResult; onRetry: () => void; onBack: () => void }) {
  const count = result.snapshot.accounting;
  const complete = result.snapshot.status === 'succeeded';
  const retryable = keywordRetryCount(result) > 0;
  const campaignObserved = result.resources.some((row) => row.kind === 'campaign' && row.status === 'created') && count.observed === count.succeeded;
  return <CampaignPage title={complete ? 'Campaign created' : count.succeeded > 0 ? 'Campaign partially created' : 'Campaign creation unresolved'} subtitle={`${count.succeeded} of ${count.operatorApproved} resources created · Initial state paused`}>
    <Notice kind={complete ? 'good' : 'warn'}><strong>{complete ? `All ${count.succeeded} resources are created` : campaignObserved ? 'The campaign is paused. Review the unresolved resources.' : 'The campaign state is not confirmed. Review the unresolved resources.'}</strong><p>{complete ? 'The campaign remains paused while you review it.' : result.resources.find((row) => row.status === 'failed')?.message ?? 'Provider completion is not confirmed.'}</p></Notice>
    <DetailsTable headings={['Resource', 'Requested', 'Succeeded', 'Status']} rows={result.resources.map((row) => [row.kind.replaceAll('_', ' '), row.requested, row.succeeded, row.status])} />
    <p>Requested {count.operatorApproved} · Attempted {count.attempted} · Succeeded {count.succeeded} · Failed {count.failed}</p>
    {complete && <p>Original request: {count.operatorApproved} resources · Created: {count.succeeded} · Failed: {count.failed}</p>}
    {result.retry && <p>Retry: {result.retry.requested} keyword requested · {result.retry.created} created · {result.retry.duplicated} duplicated resources</p>}
    <p>{complete ? 'Enabling the campaign is a separate reviewed state change.' : retryable ? 'Retry checks and sends only unresolved keywords. The campaign remains paused while you review the result.' : 'Current state must be resolved before a retry can be reviewed.'}</p>
    <div className="wa-actions">{!complete && <Button disabled={!retryable} onClick={onRetry}>Review keyword retry</Button>}<Button onClick={onBack}>{complete ? 'Return to campaign draft' : 'Return to draft'}</Button></div>
  </CampaignPage>;
}
export function KeywordRetry({ result, executor, onBack, onExport }: { result: CampaignBuilderResult; executor: CreationExecutor; onBack: () => void; onExport: () => void }) {
  const count = keywordRetryCount(result);
  return <CampaignPage title="Review keyword retry"><Notice><strong>{count > 0 ? 'Retry the keyword only' : 'Keyword retry is unavailable'}</strong><p>{count > 0 ? 'The campaign, ad group and product ad already exist. The campaign remains paused.' : 'Resolve resource and observation conflicts before reviewing a retry.'}</p></Notice>
    <DetailsTable headings={['Resource', 'Action']} rows={result.resources.map((row) => [row.kind.replaceAll('_', ' '), row.status === 'created' ? 'Reuse the created resource' : row.kind === 'keyword' && row.status === 'failed' ? 'Retry after checking current state' : 'Requires separate review'])} />
    <p>This approval covers {count} unresolved keyword creation(s). Successful resources will not be created again.</p>
    {!executor.available && <Notice>{CAMPAIGN_CREATION_UNAVAILABLE}</Notice>}
    <div className="wa-actions"><Button variant="primary" disabled={!executor.available || count === 0} onClick={() => { if (executor.available && count > 0) executor.retry(); }}>Yes, retry {count} {count === 1 ? 'keyword' : 'keywords'} in Amazon</Button><Button onClick={onBack}>Back to results</Button><Button onClick={onExport}>Export bulk sheet</Button></div>
  </CampaignPage>;
}
