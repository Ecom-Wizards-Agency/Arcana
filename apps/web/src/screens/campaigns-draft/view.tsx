'use client';
import { CampaignUnavailable } from '../campaigns/unavailable';
import { useState } from 'react';
import { CampaignBuilderRecipe, type CampaignBuilderKeyword } from '@wizard-ads/shared';
import type { DraftScreenData } from './load';
import { draftRequest, downloadDraft } from '../../campaigns/client';
import { builderBidEvidence, builderBounds } from '../../campaigns/model';
import { unavailableCampaignReview } from '../../campaigns/review';
import { buildCampaignRecipe } from '@wizard-ads/campaigns';
import { CampaignPage, Button, Input, Notice, DetailsTable, money, quantity, exposureEquation } from '../campaigns/ui';
import { BidEditor } from './bid';
import { CreationConfirm, CreationResult, KeywordRetry, type CreationExecutor } from './creation-states';

export default function DraftScreen({ data }: { data: DraftScreenData }) {
  if (data.view !== 'ready') return <CampaignPage title="Review campaign draft"><CampaignUnavailable screen="campaigns-draft" data={data} /><a href="/campaigns">Return to builder</a></CampaignPage>;
  return <DraftReady data={data} executor={data.fixtureExecutor === 'inert' ? { available: true, create: () => {}, retry: () => {} } : { available: false }} />;
}
export function DraftReady({ data, initiallyEditing = false, executor = { available: false } }: { data: Extract<DraftScreenData, { view: 'ready' }>; initiallyEditing?: boolean; executor?: CreationExecutor }) {
  const [draft, setDraft] = useState(data.draft); const [step, setStep] = useState(data.step);
  const [editing, setEditing] = useState(initiallyEditing); const [edits, setEdits] = useState(draft.recipe);
  const [keywordIndex, setKeywordIndex] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const currency = data.context.profile.currencyCode;
  function navigate(next: string) { setStep(next); const url = new URL(window.location.href); url.searchParams.set('step', next); window.history.replaceState(null, '', url); }
  async function save(recipe: CampaignBuilderRecipe) {
    setBusy(true); setError('');
    try { const saved = await draftRequest({ action: 'save', profileId: draft.profileId, id: draft.id, expectedRevision: draft.revision, recipe, validate: true }); setDraft(saved); setEdits(saved.recipe); setEditing(false); navigate(saved.status === 'blocked' ? 'validation' : 'review'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Save unavailable'); }
    finally { setBusy(false); }
  }
  async function validate() {
    setBusy(true); setError('');
    try { const saved = await draftRequest({ action: 'validate', profileId: draft.profileId, id: draft.id, expectedRevision: draft.revision }); setDraft(saved); navigate(saved.status === 'blocked' ? 'validation' : 'review'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Validation unavailable'); }
    finally { setBusy(false); }
  }
  async function exportSheet() { try { await downloadDraft(draft.profileId, draft.id); } catch (error) { setError(error instanceof Error ? error.message : 'Export unavailable'); } }
  function useBid(keyword: CampaignBuilderKeyword) { const recipe = { ...draft.recipe, keywords: draft.recipe.keywords.map((item, index) => index === keywordIndex ? keyword : item) }; void save(recipe); }
  if (step === 'bid') return <><BidEditor keyword={draft.recipe.keywords[keywordIndex]!} evidence={builderBidEvidence(data.context, draft.recipe.keywords[keywordIndex]!.text)}
    match={draft.recipe.play === 'discovery' || draft.recipe.play === 'shield' ? 'Phrase' : 'Exact'} bounds={builderBounds(data.context, draft.recipe.groupId)} currency={currency} topOfSearch={draft.recipe.topOfSearch} audienceAdjustment={draft.recipe.audienceAdjustment}
    frozenRationale={draft.rationale[keywordIndex]?.sentence} sqpMeasured={data.context.sqpMeasured} onUse={useBid} onCancel={() => navigate('review')} />{error && <Notice kind="bad">{error}</Notice>}</>;
  if (step === 'confirm') return <><CreationConfirm review={data.review.plan.fingerprint === draft.plan.fingerprint ? data.review : unavailableCampaignReview(draft, data.context.profile.label, draft.updatedAt)} checks={draft.validation?.checks ?? []} executor={data.executorAvailable && draft.status === 'validated' ? executor : { available: false }} onExport={() => void exportSheet()} marketplaceLabel={data.context.profile.countryCode} onBack={() => navigate('review')} />{error && <Notice kind="bad">{error}</Notice>}</>;
  if (step === 'result' && data.result) return <CreationResult result={data.result} onRetry={() => navigate('retry')} onBack={() => navigate('review')} />;
  if (step === 'retry' && data.result) return <KeywordRetry result={data.result} executor={executor} onBack={() => navigate('result')} onExport={() => void exportSheet()} />;
  if (step === 'result' || step === 'retry') return <CampaignPage title={step === 'result' ? 'Campaign result' : 'Review keyword retry'}><Notice>No creation result has been recorded. Creation in Amazon is not available yet.</Notice><Button onClick={() => navigate('review')}>Return to draft</Button></CampaignPage>;
  const issues = draft.validation?.checks.filter((check) => check.blocking) ?? [];
  const blocked = step === 'validation' || draft.status === 'blocked';
  const count = draft.plan.counts.byKind['campaign.create'];
  const namePassed = draft.validation?.checks.find((check) => check.id === 'unique-name')?.status === 'passed';
  const exposureCheck = draft.validation?.checks.find((check) => check.id === 'exposure');
  const editedBounds = builderBounds(data.context, edits.groupId);

  return <CampaignPage title={blocked ? 'Fix draft issues' : 'Review campaign draft'} subtitle={`Sponsored Products · ${quantity(count, 'campaign')}`}>
    {error && <Notice kind="bad">{error}</Notice>}
    {draft.status === 'validated' && <Notice kind="good"><strong>Ready to create {quantity(count, 'campaign')}</strong><p>Budget, name and exposure checks passed for this draft. Unmeasured checks remain listed at confirmation.</p></Notice>}
    {blocked ? <><h2>{quantity(issues.length, 'issue')} {issues.length === 1 ? 'blocks' : 'block'} campaign creation</h2><DetailsTable headings={['Issue', 'Current value', 'Required action']} rows={issues.map((issue) => [issue.label, issue.currentValue, issue.requiredAction])} /><Notice kind="warn">Fix {issues.length === 1 ? 'the issue' : `all ${issues.length} issues`} before creation. Your campaign draft is saved. No resources have been created in Amazon.</Notice></> : <DetailsTable headings={['Draft setting', draft.status === 'validated' ? 'Reviewed value' : 'Value']} rows={[
      ['Ad type', 'Sponsored Products'], ['Campaigns', `${count} · Created paused`], ['Resources', [quantity(draft.plan.counts.byKind['campaign.create'], 'campaign'), quantity(draft.plan.counts.byKind['ad_group.create'], 'ad group'), quantity(draft.plan.counts.byKind['ad.create'], 'product ad'), quantity(draft.plan.counts.byKind['target.create'], 'keyword')].join(', ')],
      ['Daily budget', money(draft.recipe.dailyBudget, currency)], ['Campaign names', <>{draft.plan.nodes.filter((node) => node.kind === 'campaign.create').map((node) => node.payload.name).join('; ')}{draft.status === 'validated' && namePassed && <p style={{ color: 'var(--wa-good-text)' }}>Distinct name confirmed</p>}</>],
      ['Top-of-search adjustment', `${draft.recipe.topOfSearch}%`], ['Initial campaign state', 'Paused'],
      ...draft.recipe.keywords.flatMap((keyword) => [[`Starting bid · ${keyword.text}`, money(keyword.bid, currency)], ['Maximum exposure', <>{exposureEquation(keyword.bid, draft.recipe.topOfSearch, draft.recipe.audienceAdjustment, currency)}{draft.status === 'validated' && exposureCheck?.status === 'passed' && <p style={{ color: 'var(--wa-good-text)' }}>{exposureCheck.requiredValue ? `Within ${exposureCheck.requiredValue} hard ceiling · Passed` : 'Exposure check passed. Reviewed ceiling was not recorded; revalidate to record it.'}</p>}</>]]),
    ]} />}
    <details><summary>Rationale, frozen when saved</summary>{draft.rationale.map((item) => <p key={item.keyword}>{item.sentence}</p>)}<p className="wa-hint">Stored with the draft. Later changes to the method or defaults cannot rewrite it.</p></details>
    <div className="wa-actions"><Button variant={blocked ? 'primary' : 'default'} onClick={() => { setEdits(draft.recipe); setEditing(true); }}>Edit draft</Button>{draft.recipe.keywords.map((keyword, index) => <Button key={keyword.text} onClick={() => { setKeywordIndex(index); navigate('bid'); }}>Edit starting bid{draft.recipe.keywords.length > 1 ? ` · ${keyword.text}` : ''}</Button>)}
      <Button variant={draft.status === 'validated' || blocked ? 'default' : 'primary'} disabled={busy} onClick={() => void validate()}>Validate draft</Button><Button variant="primary" disabled={draft.status !== 'validated' || busy || editing} onClick={() => navigate('confirm')}>Continue to confirmation</Button><Button onClick={() => void exportSheet()}>Export bulk sheet</Button></div>
    {editing && <dialog open aria-label="Edit campaign draft" style={{ position: 'fixed', inset: '15% auto auto 35%', zIndex: 20, background: 'var(--wa-surface-2)', color: 'var(--wa-text)', border: '1px solid var(--wa-border)', borderRadius: 'var(--wa-radius)', padding: 24, maxWidth: 560 }}><h2>Edit campaign draft</h2><div className="wa-stack">
      <label>Daily budget · {currency}<Input aria-label="Draft daily budget" type="number" value={edits.dailyBudget} onChange={(event) => setEdits({ ...edits, dailyBudget: Number(event.target.value) })} /></label>
      <label>Top-of-search adjustment · %<Input aria-label="Draft top-of-search adjustment" type="number" value={edits.topOfSearch} onChange={(event) => setEdits({ ...edits, topOfSearch: Number(event.target.value) })} /></label>
      {edits.keywords.map((keyword, index) => <label key={keyword.text}>Starting bid · {keyword.text} · {currency}<Input aria-label={`Draft bid ${index + 1}`} type="number" value={keyword.bid} onChange={(event) => setEdits({ ...edits, keywords: edits.keywords.map((item, current) => current === index ? { ...item, bid: Number(event.target.value), basis: 'manual' } : item) })} /></label>)}
      {(Object.keys(draft.recipe.names).length ? Object.entries(draft.recipe.names).sort(([a], [b]) => Number(a) - Number(b)).map(([, name]) => name) : buildCampaignRecipe(draft.recipe, data.context).campaigns.map((campaign) => campaign.name)).map((name, index) => <label key={index}>Campaign name<Input aria-label={`Draft campaign name ${index + 1}`} value={edits.names[String(index)] ?? name} onChange={(event) => setEdits({ ...edits, names: { ...edits.names, [index]: event.target.value } })} /></label>)}
      <section className="campaign-rationale" aria-label="Edited values summary"><h3>Review edited values</h3><p>Daily budget: {money(edits.dailyBudget, currency)} · Top of search: {edits.topOfSearch}%</p>{edits.keywords.map((keyword) => <p key={keyword.text}>{keyword.text} · Starting bid {money(keyword.bid, currency)} · Maximum exposure: {exposureEquation(keyword.bid, edits.topOfSearch, edits.audienceAdjustment, currency)}</p>)}<p>Hard ceiling: {money(editedBounds.exposureCeiling, currency)}. Saving revalidates the exact edited draft.</p></section><div className="wa-actions"><Button onClick={() => setEditing(false)}>Close</Button><Button variant="primary" disabled={busy || !CampaignBuilderRecipe.safeParse(edits).success} onClick={() => void save(edits)}>Save draft</Button></div>
    </div></dialog>}
  </CampaignPage>;
}
