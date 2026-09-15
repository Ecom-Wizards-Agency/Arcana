'use client';
import { useState } from 'react';
import { OptimizationGroupRole, type CampaignBuilderContext, type CampaignBuilderRecipe } from '@wizard-ads/shared';
import { campaignRequest } from '../../campaigns/client';
import { Button, Select, Input, Textarea, Notice, quantity } from './ui';

export const KEYWORD_SOURCES = [['paste', 'Paste'], ['search-terms', 'From search terms'], ['ngrams', 'From n-grams'], ['rank-radar', 'From Rank Radar'], ['saved', 'Saved keyword set']] as const;
export const PLAY_COPY = {
  rank: ['Rank', 'Buy velocity on keywords we want to own organically.', 'SKW exact · fixed bids · one campaign per keyword · ACOS is not a cut criterion'],
  discovery: ['Discovery', 'Find search terms we do not have yet.', 'Phrase or Auto · down-only · one campaign per keyword set'],
  profit: ['Profit', 'Harvest what already converts.', 'Halo exact group · down-only · one campaign for the set'],
  shield: ['Shield', 'Defend our brand and our own detail pages.', 'Brand terms exact + self-target PAT · down-only'],
} as const;
export function Targets({ context, play, onPlay, text, onText, structure, onStructure, initialSource = 'paste', productCount = 0 }: {
  context: CampaignBuilderContext; play: CampaignBuilderRecipe['play']; onPlay: (play: CampaignBuilderRecipe['play']) => void;
  text: string; onText: (value: string) => void; structure: CampaignBuilderRecipe['structure']; onStructure: (value: CampaignBuilderRecipe['structure']) => void;
  initialSource?: typeof KEYWORD_SOURCES[number][0]; productCount?: number;
}) {
  const [source, setSource] = useState(initialSource); const [setName, setSetName] = useState(''); const [message, setMessage] = useState('');
  const candidates = source === 'search-terms' ? context.searchTerms : source === 'ngrams' ? context.ngrams : [];
  const keywordCount = new Set(text.split('\n').map((line) => line.trim()).filter(Boolean)).size;
  return <section className="wa-stack campaign-targets"><h2>Pick a play</h2><p className="wa-hint">Four words your account already speaks — the campaign names encode them and optimization_groups.role is literally this enum.</p><div className="campaign-plays">{OptimizationGroupRole.options.map((role) => <Button key={role} aria-pressed={play === role} onClick={() => onPlay(role)} className="campaign-play"><strong>{PLAY_COPY[role][0]}</strong><p>{PLAY_COPY[role][1]}</p><span className="wa-hint">{PLAY_COPY[role][2]}</span></Button>)}</div>
    <h3>Where the keywords come from</h3><div className="wa-actions campaign-source-tabs" role="tablist" aria-label="Keyword source">{KEYWORD_SOURCES.map(([value, label]) => <Button key={value} role="tab" aria-selected={value === source} onClick={() => setSource(value)}>{label}</Button>)}</div>
    {source === 'rank-radar' ? <Notice>Not measured. Rank Radar has no source table yet.</Notice> : source === 'saved' ? context.keywordSets.length ? <Select aria-label="Saved keyword set" defaultValue="" onChange={(event) => { const set = context.keywordSets.find((item) => item.id === event.target.value); if (set) onText(set.keywords.join('\n')); }}><option value="" disabled>Choose a keyword set</option>{context.keywordSets.map((set) => <option key={set.id} value={set.id}>{set.name} · {set.keywords.length} keywords</option>)}</Select> : <Notice>No saved keyword sets for this profile.</Notice> : source !== 'paste' ? <div className="wa-actions campaign-keyword-candidates">{candidates.length ? candidates.map((keyword) => <Button key={keyword} onClick={() => onText([...new Set([...text.split('\n').filter(Boolean), keyword])].join('\n'))}>{keyword}</Button>) : <Notice>No {source === 'ngrams' ? 'n-gram' : 'search-term'} evidence in this period.</Notice>}</div> : null}
    <Textarea aria-label="Keywords" placeholder="One keyword per line" rows={2} value={text} onChange={(event) => onText(event.target.value)} />
    <div className="campaign-structure"><Select aria-label="Campaign structure" value={structure} onChange={(event) => onStructure(event.target.value as CampaignBuilderRecipe['structure'])}><option value="keyword-product">Create one campaign per keyword, per product</option><option value="set-product">Create one campaign for the keyword set, per product</option></Select><p>{quantity(keywordCount, 'keyword')} × {quantity(productCount, 'product')} = {quantity(structure === 'keyword-product' ? keywordCount * productCount : productCount, 'campaign')}{structure === 'keyword-product' ? ', 1 keyword each' : ', the keyword set in each'}</p></div>
    <details><summary>Save these keywords as a set</summary><div className="wa-actions"><Input aria-label="Keyword set name" placeholder="Keyword set name" value={setName} onChange={(event) => setSetName(event.target.value)} /><Button disabled={!context.canEdit || !setName.trim() || !text.trim()} onClick={async () => { try { await campaignRequest('/api/campaigns/keyword-sets', { id: crypto.randomUUID(), profileId: context.profile.id, name: setName, keywords: [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))] }); setMessage('Keyword set saved.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Save unavailable'); } }}>Save keyword set</Button></div></details>{message && <Notice>{message}</Notice>}
  </section>;
}
