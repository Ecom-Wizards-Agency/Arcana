'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MarketPositionSettings } from '@wizard-ads/shared';
import { EmptyState, Button, Input } from '../../ui/primitives';
import { MarketPositionPresentation } from './presentation';
import type { MarketPositionData } from './load';

export default function ScreenView({ data }: { data: MarketPositionData }) {
  if (data.view === 'gated') return <main><p>Market position requires an available database and organisation membership.</p></main>;
  if (data.view === 'empty') return <main><EmptyState title="No profiles yet" body="Connect a profile to compare advertised products." action={<a href="/settings/integrations">Manage integrations</a>} /></main>;
  return <MarketPosition key={`${data.profileId}:${data.selectedAsin}:${data.settings.updatedAt}`} data={data} />;
}
function MarketPosition({ data }: { data: Extract<MarketPositionData, { view: 'ready' }> }) {
  const router = useRouter();
  const query = useSearchParams();
  const [threshold, setThreshold] = useState(String(data.settings.thresholdPercent));
  const [savedThreshold, setSavedThreshold] = useState(data.settings.thresholdPercent);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [category, setCategory] = useState(data.series.find((series) => series.asin === data.selectedAsin && series.category)?.category ?? '');
  async function saveThreshold() {
    if (saving) return;
    const value = threshold.trim() === '' ? NaN : Number(threshold);
    if (!Number.isFinite(value) || value < 0 || value > 100) { setSaveMessage('Enter a threshold from 0 to 100 percent.'); return; }
    setSaving(true); setSaveMessage('');
    try {
      const response = await fetch('/api/market-position/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: data.profileId, thresholdPercent: value }) });
      if (!response.ok) throw new Error('Save failed');
      const saved = MarketPositionSettings.parse(await response.json());
      if (saved.profileId !== data.profileId || saved.thresholdPercent !== value) throw new Error('Readback mismatch');
      setSavedThreshold(saved.thresholdPercent); setSaveMessage('Threshold saved.');
    } catch { setSaveMessage('The save could not be confirmed. Reload before trying again.'); }
    finally { setSaving(false); }
  }

  return <MarketPositionPresentation data={data} category={category} threshold={savedThreshold} onCategory={setCategory}
    onProduct={(asin) => { const next = new URLSearchParams(query.toString()); next.set('profile', data.profileId); next.set('asin', asin); router.push(`/market-position?${next}`); }}
    onAdjust={() => setEditing(!editing)} editor={editing && data.canEdit ? <form onSubmit={(event) => { event.preventDefault(); void saveThreshold(); }} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', paddingTop: '0.5rem', fontSize: 'var(--wa-fs-xs)' }}>
      <label htmlFor="market-threshold">Threshold (% of your BSR)</label>
      <Input id="market-threshold" type="number" min={0} max={100} step="any" value={threshold} onChange={(event) => setThreshold(event.target.value)} disabled={saving} style={{ width: '5rem' }} />
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save threshold'}</Button><span role="status">{saveMessage}</span>
    </form> : null} />;
}
