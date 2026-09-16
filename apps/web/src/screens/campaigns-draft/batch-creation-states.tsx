'use client';
import { campaignCreationBatchSummary, campaignCreationRetrySelection, type CampaignCreationBatch } from '@wizard-ads/shared';
import { Button, CampaignPage, DetailsTable, Notice, quantity } from '../campaigns/ui';
import type { CreationExecutor } from './creation-states';

function resourceName(batch: CampaignCreationBatch, id: string): string {
  const node = batch.plan.nodes.find((node) => node.nodeId === id);
  if (node?.kind === 'campaign.create') return `Campaign · ${node.payload.name}`;
  if (node?.kind === 'ad_group.create') return `Ad group · ${node.payload.name}`;
  if (node?.kind === 'target.create' && node.payload.targetType === 'keyword') return `Keyword · “${node.payload.text}”`;
  return node?.kind === 'ad.create' ? 'Product ad' : 'Resource';
}
export function BatchCreationResult({ batch, onRetry, onBack }: { batch: CampaignCreationBatch; onRetry(): void; onBack(): void }) {
  const summary = campaignCreationBatchSummary(batch); const count = summary.accounting;
  const inherited = batch.lineage?.inheritedResources ?? [];
  const resources = batch.plan.nodes.filter((node) => node.effect === 'irreversible_create');
  const observed = count.observed + inherited.length;
  const succeeded = count.succeeded + inherited.length;
  const complete = observed === resources.length && summary.terminal;
  const selection = campaignCreationRetrySelection(batch);
  const campaigns = batch.plan.nodes.filter((node) => node.kind === 'campaign.create');
  const identityFor = (nodeId: string) => batch.nodes.find((row) => row.nodeId === nodeId)?.observation?.observation === 'observed'
    ? batch.nodes.find((row) => row.nodeId === nodeId)!.observation!.providerEntityId
    : inherited.find((row) => row.nodeId === nodeId)?.providerEntityId;
  const campaignObserved = campaigns.every((node) => Boolean(identityFor(node.nodeId)));
  return <CampaignPage layout="review" title={!summary.terminal ? 'Campaign creation in progress' : summary.state === 'needs_attention'
    ? 'Campaign creation needs attention' : complete ? 'Campaign created' : succeeded > 0 ? 'Campaign partially created' : 'Campaign creation failed'}
    subtitle={`${succeeded} of ${resources.length} resources ${count.adopted ? 'created or found' : 'created'} · ${campaignObserved ? 'Campaign paused' : 'Initial state paused'}`}>
    {!summary.terminal && <p role="status" aria-busy="true">Waiting for the worker and Amazon observation. This page checks the recorded batch every two seconds.</p>}
    <p className="campaign-accounting">Batch {batch.id} · Parsed {count.parsed} · Loaded {count.loaded} · Attempted {count.attempted} · Succeeded {count.succeeded} · Failed {count.failed} · Observed {count.observed}</p>
    <p>POSTs accepted {count.providerSucceeded} · Existing resources adopted {count.adopted} · Inherited resources {inherited.length}</p>
    {batch.lineage && <p>Retry of batch {batch.lineage.parentBatchId}. This approval covers {quantity(batch.nodes.length, 'resource')}.</p>}
    <Notice kind={complete ? 'good' : 'warn'}><strong>{complete ? `All ${resources.length} resources are observed` : summary.state === 'needs_attention'
      ? 'Creation stopped for operator review' : 'Review each resource below'}</strong>
      <p>{complete ? 'The campaign remains paused. Enabling it is a separate reviewed state change.'
        : 'Created resources remain in place. No resource is deleted or automatically created again.'}</p></Notice>
    <DetailsTable headings={['Resource', 'Requested', 'Succeeded', 'Status']} rows={resources.map((node) => {
      const row = batch.nodes.find((row) => row.nodeId === node.nodeId);
      const reused = inherited.some((row) => row.nodeId === node.nodeId);
      const read = row?.observation;
      const success = reused || row?.result?.outcome === 'succeeded' || read?.observation === 'observed';
      const status = reused ? 'Reused · Observed' : read?.observation === 'uncertain' ? 'Uncertain · Needs attention'
        : read?.observation === 'ambiguous_readback' ? 'Refused · ambiguous_readback'
          : read?.observation === 'conflict' ? 'Conflict · Configuration differs'
            : read?.observation === 'observed' ? row?.result?.outcome === 'succeeded' ? 'Created · Observed' : 'Found existing · Observed'
              : row?.refusal ? row.refusal === 'dependency_failed' ? 'Blocked · Review required' : 'Refused · Authority unavailable'
                : row?.result?.outcome === 'authoritative_rejected' ? `Failed · ${row.result.providerCode ?? 'Amazon refused the resource'}`
                  : row?.result?.outcome === 'succeeded' ? 'Accepted · Observation pending' : row?.intent ? 'Unknown · Reading exact identity' : 'Pending';
      return [resourceName(batch,node.nodeId), 1, success ? 1 : 0, status];
    })} />
    {batch.nodes.filter((row) => row.observation?.reason || row.result?.sanitizedMessage).map((row) => <p key={row.nodeId}>
      <strong>{resourceName(batch,row.nodeId)}:</strong> {row.observation?.reason ?? row.result?.sanitizedMessage}</p>)}
    <details><summary>Observation evidence · {batch.nodes.reduce((total,row) => total + row.observations.length,0)} reads</summary>
      <ul>{batch.nodes.flatMap((row) => row.observations.map((read) => <li key={read.id}>{resourceName(batch,row.nodeId)} · {read.observedAt} · {read.observation.replaceAll('_',' ')} · {read.accounting.parsed}/{read.accounting.loaded} rows parsed · {read.accounting.matched} matches{read.reason ? ` · ${read.reason}` : ''}</li>))}</ul>
    </details>
    {campaigns.map((node) => { const amazonId = identityFor(node.nodeId); return amazonId ? <p key={node.nodeId}><a href={`/grid?${new URLSearchParams({profile:batch.plan.profileId,entity:'campaigns',campaign:amazonId})}`}>View {node.payload.name} in the campaign grid</a></p> : null; })}
    <div className="wa-actions">{!complete && <Button variant="primary" disabled={!selection.available} onClick={onRetry}>Review {selection.keywordOnly ? 'keyword' : 'resource'} retry</Button>}
      <Button onClick={onBack}>Return to campaign draft</Button></div>
  </CampaignPage>;
}

export function BatchCreationRetry({ batch, executor, onBack }: { batch: CampaignCreationBatch; executor: CreationExecutor; onBack(): void }) {
  const selection = campaignCreationRetrySelection(batch); const count = selection.nodeIds.length;
  const unit = selection.keywordOnly ? 'keyword' : 'resource';
  const inheritedIds = new Set([...(batch.lineage?.inheritedResources.map((row) => row.nodeId) ?? []),
    ...batch.nodes.filter((row) => row.observation?.observation === 'observed').map((row) => row.nodeId)]);
  return <CampaignPage layout="review" title={`Review ${unit} retry`} subtitle={`${inheritedIds.size} resources already observed`}>
    <Notice>The worker reads each exact identity before creating. One matching resource is reused; multiple matches refuse creation.</Notice>
    {selection.uncertainNodeIds.length > 0 && <Notice kind="warn"><strong>The original request may have created a resource that is not visible yet.</strong>
      <p>If the fresh read still finds none, this approval permits a new create. A delayed original resource could appear later and cause a duplicate.</p></Notice>}
    <ul>{batch.plan.nodes.filter((node) => inheritedIds.has(node.nodeId)).map((node) => <li key={node.nodeId}>{node.kind === 'campaign.create' ? 'Reuse the created campaign'
      : node.kind === 'ad_group.create' ? 'Reuse the created ad group' : node.kind === 'ad.create' ? 'Keep the created product ad' : `Reuse ${resourceName(batch,node.nodeId)}`}</li>)}</ul>
    <DetailsTable headings={['Resource', 'Current result', 'Action']} rows={selection.nodeIds.map((id) => {
      const row = batch.nodes.find((row) => row.nodeId === id)!;
      return [resourceName(batch,id), row.observation?.observation === 'uncertain' ? 'Uncertain' : row.intent ? 'Failed' : 'Not attempted', 'Read exact identity; create only if none exists'];
    })} />
    {!selection.available && <Notice kind="warn">Retry is unavailable while resources are in progress, ambiguous, conflicting, or outside this approval.</Notice>}
    {!executor.available && <Notice>Retry in Amazon is unavailable for this profile or while another request is submitting.</Notice>}
    <p>This separate approval covers exactly {quantity(count,unit)}. Observed parents will not be created again.</p>
    <div className="wa-actions"><Button variant="primary" disabled={!executor.available || !selection.available} onClick={() => { if (executor.available && selection.available) executor.retry(); }}>Yes, retry {count} {count === 1 ? unit : `${unit}s`} in Amazon</Button>
      <Button onClick={onBack}>Back to results</Button><Button disabled>Export bulk sheet</Button></div>
  </CampaignPage>;
}
