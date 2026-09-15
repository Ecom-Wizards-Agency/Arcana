'use client';
import { orderCampaignCreationNodes, CAMPAIGN_CREATION_UNAVAILABLE, CampaignBuilderCheck, type CampaignBuilderResult, type CampaignCreationPlan } from '@wizard-ads/shared';
import type { CampaignCreationApprovalView } from '@wizard-ads/shared/campaign-creation-approval';
import { Button, CampaignPage, DetailsTable, Notice, quantity } from '../campaigns/ui';

export type CreationExecutor = { available: false } | { available: true; create: () => void; retry: () => void };
export function CreationConfirm({ review, checks, executor, onExport, onBack, marketplaceLabel }: {
  marketplaceLabel?: string; review: CampaignCreationApprovalView; checks: CampaignBuilderCheck[]; executor: CreationExecutor; onExport: () => void; onBack: () => void;
}) {
  const nodes = orderCampaignCreationNodes(review.plan.nodes).filter((node) => node.effect === 'irreversible_create');
  const count = review.plan.counts.byKind['campaign.create'];
  const currency = review.plan.nodes.find((node) => node.kind === 'campaign.create')?.payload.budget.currencyCode ?? '';
  const completeChecks = CampaignBuilderCheck.shape.id.options.every((id) => checks.filter((check) => check.id === id).length === 1);
  const available = executor.available && completeChecks && !checks.some((check) => check.blocking) && review.freshness.status === 'current';
  const labels = { 'campaign.create': 'Campaign', 'ad_group.create': 'Ad group', 'ad.create': 'Product ad', 'target.create': 'Keyword', 'creative.create': 'Creative' };
  return <CampaignPage layout="review" title="Confirm campaign creation"><section className="campaign-rationale"><h2>Create {quantity(count, 'campaign')} in Amazon</h2><p className="wa-hint">{review.profile.label} · {marketplaceLabel ?? 'Marketplace label unavailable'} · {currency} · Campaign starts paused</p></section>
    <DetailsTable columnWidths={['34%', '18%', '48%']} headings={['Resource', 'Count', 'After creation']} rows={nodes.map((node) => [labels[node.kind as keyof typeof labels] ?? node.kind, 1, node.kind === 'campaign.create' ? 'Paused' : node.kind === 'target.create' ? 'Using the reviewed bid' : node.kind === 'ad.create' ? 'In the new ad group' : 'In the new campaign'])} />
    <p>{nodes.length} resources will be created in order. Validation must pass for the exact draft you approve.</p><p>Payload fingerprint <code>{review.plan.fingerprint}</code></p>
    <Notice kind="warn"><strong>Created resources cannot be deleted through rollback.</strong><p>Pausing or archiving them requires a separate reviewed action.</p></Notice>
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
  const unresolvedKeywords = keywordRetryCount(result);
  const retryable = unresolvedKeywords > 0;
  const campaignObserved = result.resources.some((row) => row.kind === 'campaign' && row.status === 'created') && count.observed === count.succeeded;
  const resourceDetails = <details open={!complete}><summary>Resource details</summary><DetailsTable columnWidths={['35%', '18%', '18%', '29%']} headings={['Resource', 'Requested', 'Succeeded', 'Status']} rows={result.resources.map((row) => [({ campaign: 'Campaign', ad_group: 'Ad group', product_ad: 'Product ad', keyword: 'Keyword' })[row.kind], row.requested, row.succeeded, row.status === 'created' ? `Created${row.kind === 'campaign' ? ' · Paused' : ''}` : row.status === 'failed' ? `Failed · ${row.responseCode ?? 'Reason not recorded'}` : row.status === 'pending' ? 'Pending' : 'Unknown'])} />
    <p className="campaign-accounting">Requested {count.operatorApproved} · Attempted {count.attempted} · Succeeded {count.succeeded} · Failed {count.failed}</p></details>;
  return <CampaignPage layout="review" title={complete ? 'Campaign created' : count.succeeded > 0 ? 'Campaign partially created' : 'Campaign creation unresolved'} subtitle={`${count.succeeded} of ${count.operatorApproved} resources created · Initial state paused`}>
    <Notice kind={complete ? 'good' : 'warn'}><strong>{complete ? `All ${count.succeeded} resources are created` : campaignObserved ? retryable ? `The campaign is paused. ${unresolvedKeywords === 1 ? 'The keyword failed.' : `${unresolvedKeywords} keywords failed.`}` : 'The campaign is paused. Review the unresolved resources.' : 'The campaign state is not confirmed. Review the unresolved resources.'}</strong><p>{complete ? `${result.retry ? 'The keyword retry succeeded. ' : ''}The campaign remains paused while you review it.` : result.resources.find((row) => row.status === 'failed')?.message ?? 'Provider completion is not confirmed.'}</p></Notice>
    {!complete && resourceDetails}
    {complete && <p className="campaign-accounting">Original request: {count.operatorApproved} resources · Created: {count.succeeded} · Failed: {count.failed}</p>}
    {result.retry && <p>Retry: {quantity(result.retry.requested, 'keyword')} requested · {result.retry.created} created · {result.retry.duplicated} duplicated resources</p>}
    {complete && resourceDetails}
    <p>{complete ? 'Enabling the campaign is a separate reviewed state change.' : retryable ? `Retry checks and sends only ${unresolvedKeywords === 1 ? 'the unresolved keyword' : quantity(unresolvedKeywords, 'unresolved keyword')}. The campaign remains paused while you review the result.` : 'Current state must be resolved before a retry can be reviewed.'}</p>
    <div className="wa-actions">{!complete && <Button variant="primary" disabled={!retryable} onClick={onRetry}>Review keyword retry</Button>}<Button onClick={onBack}>{complete ? 'Return to campaign draft' : 'Return to draft'}</Button></div>
  </CampaignPage>;
}
export function KeywordRetry({ result, plan, executor, onBack }: { result: CampaignBuilderResult; plan: CampaignCreationPlan; executor: CreationExecutor; onBack: () => void }) {
  const count = keywordRetryCount(result);
  const namesResolved = result.resources.filter((row) => row.kind === 'keyword' && row.status === 'failed').every((row) => plan.nodes.some((node) => node.nodeId === row.nodeId && node.kind === 'target.create' && node.payload.targetType === 'keyword'));
  const unresolved = result.resources.filter((row) => row.kind === 'keyword' && row.status === 'failed').map((row) => {
    const node = plan.nodes.find((node) => node.nodeId === row.nodeId);
    return node?.kind === 'target.create' && node.payload.targetType === 'keyword' ? `“${node.payload.text}”` : `Keyword name unavailable (resource ${row.nodeId})`;
  });
  return <CampaignPage layout="review" title="Review keyword retry" subtitle={`Campaign paused · ${quantity(result.snapshot.accounting.succeeded, 'resource')} already created`}><section className="campaign-rationale"><strong>{count > 0 ? 'Retry the keyword only' : 'Keyword retry is unavailable'}</strong><p>{count > 0 ? 'The campaign, ad group and product ad already exist. The campaign remains paused.' : 'Resolve resource and observation conflicts before reviewing a retry.'}</p></section>
    <DetailsTable headings={['Resource', 'Action']} rows={result.resources.map((row) => [({ campaign: 'Campaign', ad_group: 'Ad group', product_ad: 'Product ad', keyword: 'Keyword' })[row.kind], row.status === 'created' ? row.kind === 'product_ad' ? 'Keep the created product ad' : `Reuse the created ${row.kind === 'ad_group' ? 'ad group' : row.kind}` : row.kind === 'keyword' && row.status === 'failed' ? 'Retry after checking current state' : 'Requires separate review'])} />
    <p>This approval covers {quantity(count, 'unresolved keyword creation')}. Successful resources will not be created again.</p>
    {!executor.available && <Notice>Retry in Amazon is not available yet. The campaign remains paused.</Notice>}
    {!namesResolved && <Notice kind="warn">The unresolved keyword does not match this draft. Return to the recorded result before reviewing a retry.</Notice>}
    <p>Unresolved {unresolved.length === 1 ? 'keyword' : 'keywords'}: {unresolved.join('; ') || 'None recorded'}.</p>
    <Notice>Keyword-only export is not available. Export is disabled here so the existing campaign, ad group and product ad cannot be created again.</Notice>
    <div className="wa-actions"><Button variant="primary" disabled={!executor.available || count === 0 || !namesResolved} onClick={() => { if (executor.available && count > 0 && namesResolved) executor.retry(); }}>Yes, retry {count} {count === 1 ? 'keyword' : 'keywords'} in Amazon</Button><Button onClick={onBack}>Back to results</Button><Button disabled>Export bulk sheet</Button></div>
  </CampaignPage>;
}
