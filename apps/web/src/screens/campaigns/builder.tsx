'use client';
import { useState } from 'react';
import { buildCampaignRecipe, summarizePlan } from '@wizard-ads/campaigns';
import { CampaignBuilderRecipe, type CampaignBuilderContext, type CampaignBuilderAdType } from '@wizard-ads/shared';
import { draftRequest, downloadDraft } from '../../campaigns/client';
import { AdTypeCards, Products } from './products';
import { Targets, PLAY_COPY, type KEYWORD_SOURCES } from './targets';
import { Button, Input, Select, Notice, DetailsTable, money, NO_ROLLBACK_NOTE } from './ui';

export function Builder({ context, initialStep = 'products', initialRecipe, initialSource }: {
  context: CampaignBuilderContext; initialStep?: 'products' | 'targets' | 'review'; initialRecipe?: CampaignBuilderRecipe;
  initialSource?: typeof KEYWORD_SOURCES[number][0];
}) {
  const [step, setStep] = useState(initialStep);
  const [adType, setAdType] = useState<CampaignBuilderAdType>(initialRecipe?.adType ?? 'SP');
  const [products, setProducts] = useState(initialRecipe?.productKeys ?? []);
  const [play, setPlay] = useState<CampaignBuilderRecipe['play']>(initialRecipe?.play ?? 'rank');
  const [groupId, setGroupId] = useState(initialRecipe?.groupId ?? '');
  const [budget, setBudget] = useState(String(initialRecipe?.dailyBudget ?? context.defaults.budget ?? ''));
  const [bid, setBid] = useState(String(initialRecipe?.keywords[0]?.bid ?? ''));
  const [placement, setPlacement] = useState(String(initialRecipe?.topOfSearch ?? context.defaults.topOfSearch ?? ''));
  const [text, setText] = useState(initialRecipe?.keywords.map((keyword) => keyword.text).join('\n') ?? '');
  const [structure, setStructure] = useState<CampaignBuilderRecipe['structure']>(initialRecipe?.structure ?? 'keyword-product');
  const [names, setNames] = useState(initialRecipe?.names ?? {});
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const naming = context.naming;
  const group = context.groups.find((item) => item.id === groupId);
  const keywords = [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))];
  const parsed = CampaignBuilderRecipe.safeParse({ adType, productKeys: products, play, groupId, dailyBudget: budget === '' ? null : Number(budget),
    keywords: keywords.map((keyword) => ({ text: keyword, bid: bid === '' ? null : Number(bid), basis: 'manual' })),
    structure, topOfSearch: placement === '' ? null : Number(placement), audienceAdjustment: 0, naming, names });
  const recipe = parsed.success ? parsed.data : null;
  let plan: ReturnType<typeof buildCampaignRecipe> | null = null; let issue = '';
  if (recipe) { try { plan = buildCampaignRecipe(recipe, context); } catch (error) { issue = error instanceof Error ? error.message : 'Plan unavailable'; } }
  const counts = plan ? { campaigns: plan.campaigns.length, groups: plan.campaigns.length,
    products: plan.campaigns.reduce((n, campaign) => n + campaign.adGroup.productAds.length, 0),
    keywords: plan.campaigns.reduce((n, campaign) => n + campaign.adGroup.keywords.length, 0),
    negatives: plan.campaigns.reduce((n, campaign) => n + campaign.negativeKeywords.length + campaign.adGroup.negativeKeywords.length, 0) } : null;
  const total = counts ? counts.campaigns + counts.groups + counts.products + counts.keywords + counts.negatives : null;
  async function save(exportOnly: boolean) {
    if (!recipe) return;
    setBusy(true); setError('');
    try {
      const draft = await draftRequest({ action: 'save', profileId: context.profile.id, id: crypto.randomUUID(), expectedRevision: null, recipe, validate: false });
      if (exportOnly) await downloadDraft(draft.profileId, draft.id);
      else window.location.assign(`/campaigns/draft?${new URLSearchParams({ profile: draft.profileId, draft: draft.id })}`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Draft save unavailable'); }
    finally { setBusy(false); }
  }
  return <div className="campaign-builder-layout">
    <aside aria-label="Settings" className="wa-stack" style={{ background: 'var(--wa-surface-2)', padding: 10, position: 'sticky', top: 16 }}><span className="wa-hint">SETTINGS</span>
      <div><small>PLAY</small><p>{PLAY_COPY[play][0]}</p></div>
      <label><small>GROUP</small><Select aria-label="Optimization group" value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">Choose group</option>{context.groups.filter((item) => item.role === play).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label><small>BUDGET</small><Input aria-label="Daily budget" type="number" value={budget} onChange={(event) => setBudget(event.target.value)} /></label>
      <label><small>BID</small><Input aria-label="Starting bid" type="number" value={bid} onChange={(event) => setBid(event.target.value)} /></label>
      <label><small>PLACEMENT</small><Input aria-label="Top-of-search adjustment" type="number" value={placement} onChange={(event) => setPlacement(event.target.value)} /></label>
      <div><small>STATE</small><p>Paused</p></div><div><small>NAMING</small><p><a href={`/campaigns/naming?profile=${context.profile.id}`}>{naming ? 'Saved convention' : 'Configure naming'}</a></p></div>
    </aside>
    <section className="wa-stack"><div className="wa-actions" role="tablist" aria-label="Builder steps">{[['products', '1 Products'], ['targets', '2 Play & targets'], ['review', '3 Review & create']].map(([value, label]) => <Button key={value} role="tab" aria-selected={step === value} onClick={() => setStep(value as typeof step)}>{label}</Button>)}</div>
      {step === 'products' && <><AdTypeCards context={context} selected={adType} onSelect={setAdType} />{adType === 'SP' ? <Products context={context} selected={products} onSelect={setProducts} /> : <Notice>This ad type is unavailable in the current snapshot. <a href={`/campaigns/assets?profile=${context.profile.id}`}>Browse existing creative assets</a>.</Notice>}<Button onClick={() => setStep('targets')}>Continue to play & targets</Button></>}
      {step === 'targets' && <><Targets context={context} play={play} onPlay={(value) => { setPlay(value); setGroupId(''); }} text={text} onText={setText} structure={structure} onStructure={setStructure} {...(initialSource ? { initialSource } : {})} />
        <p>{keywords.length} keywords × {products.length} products = {structure === 'keyword-product' ? keywords.length * products.length : products.length} campaigns{structure === 'keyword-product' ? ', 1 keyword each' : ', the keyword set in each'}</p><Button onClick={() => setStep('review')}>Review draft</Button></>}
      {step === 'review' && <><h2>Review campaign draft</h2><p>Sponsored Products · {counts?.campaigns ?? 'No'} campaigns · Created paused</p>
        {plan ? <><DetailsTable headings={['Draft setting', 'Value']} rows={[
          ['Resources', `${counts!.campaigns} campaigns, ${counts!.groups} ad groups, ${counts!.products} product ads, ${counts!.keywords} keywords`],
          ['Daily budget per campaign', money(Number(budget), context.profile.currencyCode)], ['Starting bid', money(Number(bid), context.profile.currencyCode)], ['Top-of-search adjustment', `${placement}%`],
        ]} />{plan.campaigns.map((campaign, index) => <label key={campaign.id}>Campaign name<Input aria-label={`Campaign name ${index + 1}`} value={campaign.name} onChange={(event) => setNames({ ...names, [index]: event.target.value })} /></label>)}
          <details><summary>Bulk plan detail</summary>{summarizePlan(plan).map((line, index) => <pre key={index} style={{ whiteSpace: 'pre-wrap' }}>{line}</pre>)}</details></> : <Notice>Choose products, keywords, an optimization group, budget, bid and a saved naming convention.</Notice>}
      </>}
      <div style={{ background: 'var(--wa-text)', color: 'var(--wa-surface)', padding: 16, borderRadius: 'var(--wa-radius)' }}><small>LIVE PREVIEW</small><p data-testid="campaign-name-preview">{plan?.campaigns[0]?.name ?? 'Complete the settings to preview a name.'}</p><a style={{ color: 'inherit' }} href={`/campaigns/naming?profile=${context.profile.id}`}>Reverse Builder</a><p>Read an existing campaign name using your saved convention.</p></div>
      {(error || issue) && <Notice kind="bad">{error || issue}</Notice>}
    </section>
    <aside aria-label="Plan so far" className="wa-stack" style={{ background: 'var(--wa-surface-2)', padding: 18 }}><span className="wa-hint">PLAN SO FAR</span>
      {counts ? <><DetailsTable rows={[[counts.campaigns, 'campaigns'], [counts.groups, 'ad groups'], [counts.products, 'product ads'], [counts.keywords, 'keywords'], [counts.negatives, 'negatives']]} /><strong>{total} new Amazon resources</strong></> : <p>No complete plan yet</p>}
      <DetailsTable rows={[[ 'Est. daily budget', money(plan?.campaigns.reduce((n, campaign) => n + campaign.dailyBudget, 0), context.profile.currencyCode)], ['Initial state', 'Paused'], ['Optimization group', group?.name ?? 'Not selected'], ['Target ACOS', group?.targetAcos == null ? 'Not measured' : `${group.targetAcos * 100}%`]]} />
      <Notice kind="warn">{NO_ROLLBACK_NOTE}</Notice><Button disabled={!plan || !context.canEdit || busy} onClick={() => void save(false)}>Save campaign draft</Button><Button disabled={!plan || !context.canEdit || busy} onClick={() => void save(true)}>Export bulk sheet</Button>
      <a href={`/campaigns/update?profile=${context.profile.id}`}>Update existing campaigns</a><a href={`/campaigns/eligibility?profile=${context.profile.id}`}>Eligibility before creation</a>
    </aside>
  </div>;
}
