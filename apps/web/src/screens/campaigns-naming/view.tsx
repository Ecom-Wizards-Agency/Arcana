'use client';
import { useState } from 'react';
import { NAMING_VARIABLES, generateCampaignName, namingSettingsFromStrategy, parseCampaignName } from '@wizard-ads/campaigns';
import { CampaignNamingPreset } from '@wizard-ads/shared';
import { campaignRequest } from '../../campaigns/client';
import { Button, Input, Select, CampaignPage, Notice, Badge, quantity } from '../campaigns/ui';
import type { NamingData } from './load';
export default function NamingScreen({ data }: { data: NamingData }) {
  return data.view === 'ready' ? <NamingReady data={data} /> : <CampaignPage title="Naming conventions"><Notice>{data.message}</Notice></CampaignPage>;
}
export function NamingReady({ data, initialName = '', initiallyRead = false }: { data: Extract<NamingData, { view: 'ready' }>; initialName?: string; initiallyRead?: boolean }) {
  const [naming, setNaming] = useState(data.naming ?? { variable_order: [], delimiter: ' | ', suffix: '' });
  const [title, setTitle] = useState(''); const [presets, setPresets] = useState(data.presets);
  const [name, setName] = useState(initialName); const [read, setRead] = useState(initiallyRead);
  const destinations = data.profiles.filter((profile) => profile.id !== data.profileId);
  const [target, setTarget] = useState(destinations[0]?.id ?? ''); const [message, setMessage] = useState('');
  let preview = 'Choose naming tokens and a separator.'; let parsed: ReturnType<typeof parseCampaignName> | null = null;
  try { const settings = namingSettingsFromStrategy(naming); preview = generateCampaignName(settings, { goal: 'Rank', campaignType: 'SKW', matchType: 'EXACT', productName: '[product]', keywordText: '[keyword]', counter: 1 }, '2000-01-01'); if (read) parsed = parseCampaignName(name, settings); } catch { /* Incomplete operator input remains visibly unavailable. */ }
  const tokenLabels: Record<string, string> = { Goal: 'Role', AdType: 'Ad type', MatchType: 'Match', Keyword: 'Keyword', EW: 'Agency', Custom1: 'Agency', Counter: 'Index', CampCounter: 'Index', SP: 'Ad type', ProductName: 'Product', CampaignType: 'Campaign type' };
  const readTokens = (naming.variable_order ?? []).flatMap((token) => { const value = parsed?.slots[token]; return value === undefined ? [] : [{ token, value }]; });
  async function save() { try { const saved = CampaignNamingPreset.parse(await campaignRequest('/api/campaigns/naming', { action: 'save', name: title, naming })); setPresets([...presets.filter((item) => item.id !== saved.id), saved]); setMessage('Naming convention saved. Copy it to a profile to use it.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Save unavailable'); } }
  return <CampaignPage title="Naming conventions">
    <div style={{ background: 'var(--wa-text)', color: 'var(--wa-surface)', padding: 20, borderRadius: 'var(--wa-radius)' }}><small>LIVE PREVIEW</small><p>{preview}</p></div>
    <section className="wa-stack"><h2>Reverse Builder</h2><div className="wa-actions"><Input style={{ flex: 1 }} aria-label="Existing campaign name" value={name} onChange={(event) => { setName(event.target.value); setRead(false); }} /><Button onClick={() => setRead(true)}>Read it</Button></div>
      {read && (parsed && parsed.confidence !== 'none' ? <><div className="wa-actions">{readTokens.map(({ token, value }) => <Badge key={token}>{tokenLabels[token] ?? token} · {value}</Badge>)}</div><p>Separator “{naming.delimiter}” · {readTokens.length} tokens · matches the selected preset{parsed.confidence === 'partial' ? ' partially' : ''}. This is also what resolves a creative to its keyword; synced keyword entities are used when available.</p></> : <Notice>This name does not match the selected naming convention.</Notice>)}
    </section>
    <section className="wa-stack"><h2>Saved conventions</h2><Select aria-label="Copy destination profile" value={target} onChange={(event) => setTarget(event.target.value)}>{!destinations.length && <option value="">No other profiles connected</option>}{destinations.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</Select>
      {presets.length ? presets.map((preset) => <div key={preset.id} style={{ border: '1px solid var(--wa-border)', borderRadius: 'var(--wa-radius)', background: JSON.stringify(preset.naming) === JSON.stringify(data.naming) ? 'var(--wa-accent-soft)' : 'var(--wa-surface)', padding: 12 }}><strong>{preset.name}</strong><p>{quantity(preset.naming.variable_order?.length ?? 0, 'token')} · used by {quantity(preset.usageCount, 'profile')}</p><div className="wa-actions"><Button onClick={() => { setNaming(preset.naming); setTitle(preset.name); setRead(false); }}>Use in preview</Button><Button disabled={!data.canEdit} onClick={async () => { try { await campaignRequest('/api/campaigns/naming', { action: 'copy', id: preset.id, profileId: data.profileId }); setMessage('Convention applied to this profile. Reload the builder to use it.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Apply unavailable'); } }}>Use for this profile</Button><Button disabled={!data.canEdit || !target} onClick={async () => { try { await campaignRequest('/api/campaigns/naming', { action: 'copy', id: preset.id, profileId: target }); setMessage('Convention copied to the selected profile.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Copy unavailable'); } }}>Copy to another profile</Button></div></div>) : <Notice>No saved conventions yet.</Notice>}
    </section><details><summary>New convention</summary>    <section className="wa-stack"><Input aria-label="Convention name" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Convention name" />
      <div className="wa-actions" aria-label="Naming tokens">{NAMING_VARIABLES.map((token) => <Button key={token} aria-pressed={naming.variable_order?.includes(token) ?? false} onClick={() => setNaming({ ...naming, variable_order: naming.variable_order?.includes(token) ? naming.variable_order.filter((item) => item !== token) : [...(naming.variable_order ?? []), token] })}>{token}</Button>)}</div>
      <p>Token order: {naming.variable_order?.join(' → ') || 'No tokens selected'}</p><label>Separator<Input aria-label="Naming separator" value={naming.delimiter ?? ''} onChange={(event) => setNaming({ ...naming, delimiter: event.target.value })} /></label><label>Suffix<Input aria-label="Naming suffix" value={naming.suffix ?? ''} onChange={(event) => setNaming({ ...naming, suffix: event.target.value })} /></label>
      {naming.variable_order?.includes('Custom1') && <label>Custom token 1<Input aria-label="Custom naming token 1" value={naming.custom1_value ?? ''} onChange={(event) => setNaming({ ...naming, custom1_value: event.target.value })} /></label>}
      {naming.variable_order?.includes('Custom2') && <label>Custom token 2<Input aria-label="Custom naming token 2" value={naming.custom2_value ?? ''} onChange={(event) => setNaming({ ...naming, custom2_value: event.target.value })} /></label>}
      <Button disabled={!data.canEdit || !title.trim() || !naming.variable_order?.length || !naming.delimiter || naming.variable_order.includes('EW') && !naming.suffix} onClick={() => void save()}>Save convention</Button>
    </section>
</details>{message && <Notice>{message}</Notice>}<a href={`/campaigns?profile=${data.profileId}`}>Return to builder</a>
  </CampaignPage>;
}
