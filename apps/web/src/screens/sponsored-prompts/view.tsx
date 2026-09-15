'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SPONSORED_PROMPT_IMPORT_MAX_BYTES, SponsoredPromptImport, SponsoredPromptImportResult } from '@wizard-ads/shared';
import { tokens } from '@wizard-ads/ui';
import { Button } from "../../ui/primitives";
import type { SponsoredPromptsData } from './load';
import { PromptsPresentation } from './presentation';

export default function ScreenView({ data }: { data: SponsoredPromptsData }) {
  if (data.view !== 'ready') return <PromptsPresentation data={data} />;
  return <PromptsWorkspace key={data.snapshot.profileId} data={data} />;
}
function PromptsWorkspace({ data }: { data: Extract<SponsoredPromptsData, { view: 'ready' }> }) {
  const router = useRouter(); const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [visitError, setVisitError] = useState(false);
  const { profileId, viewedThrough } = data.snapshot;
  useEffect(() => {
    if (!data.canEdit) return;
    let active = true;
    void fetch('/api/prompts/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId, viewedThrough }) })
      .then(async (response) => {
        // Finish the response body so the shell's request-idle tracker can settle.
        await response.text();
        if (active && !response.ok) setVisitError(true);
      }).catch(() => { if (active) setVisitError(true); });
    return () => { active = false; };
  }, [profileId, viewedThrough, data.canEdit]);
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > SPONSORED_PROMPT_IMPORT_MAX_BYTES) { setMessage('The export exceeds the import size limit.'); return; }
    setText(await file.text()); setMessage('Export loaded. Review it, then import observations.');
  }
  async function submit() {
    if (busy) return; setMessage('');
    try {
      if (new TextEncoder().encode(text).length > SPONSORED_PROMPT_IMPORT_MAX_BYTES) throw new Error('The export exceeds the import size limit.');
      const raw: unknown = JSON.parse(text);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Paste a JSON export object.');
      const input = SponsoredPromptImport.safeParse({ ...raw, profileId });
      if (!input.success) throw new Error(input.error.issues[0]?.message ?? 'Check the export fields.');
      setBusy(true);
      const response = await fetch('/api/prompts/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.data) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(result !== null && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'The import could not be confirmed. Reload before trying again.');
      const counts = SponsoredPromptImportResult.parse(result);
      setMessage(`${counts.inserted} observations imported; ${counts.alreadyPresent} already present; ${counts.verified} verified.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Check the export.'); }
    finally { setBusy(false); }
  }
  const importControl = <section aria-label="Import prompt observations" style={{ border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: '1rem' }}>
    {data.canEdit ? <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2 style={{ fontSize: tokens.font.size.base, marginTop: 0 }}>Import observations</h2>
      <p style={{ color: tokens.color.textMuted, fontSize: tokens.font.size.sm }}>Paste or upload JSON with <code>metricSemantics: "disjoint_interval_deltas"</code> and a <code>rows</code> array. Each row supplies ad product, campaign, ad group, prompt text, observation time, status, interval start/end, spend, clicks, sales and orders. Use null for unavailable metrics. Cumulative exports must be converted to distinct interval amounts first.</p>
      <label htmlFor="prompt-export">Prompt export JSON</label><textarea id="prompt-export" value={text} onChange={(event) => setText(event.target.value)} rows={4} disabled={busy} style={{ display: 'block', boxSizing: 'border-box', width: '100%', margin: '0.4rem 0 0.75rem', background: tokens.color.surface, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm, fontFamily: tokens.font.mono }} />
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}><label>Upload prompt export <input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); }} /></label><Button variant="primary" size="sm" type="submit" disabled={busy || !text.trim()}>{busy ? 'Importing…' : 'Import observations'}</Button></div>
      {message ? <p role="status">{message}</p> : null}
    </form> : <p>Read-only access. An owner, admin or analyst can import observations and record a visit.</p>}
    {visitError ? <p role="status">The visit marker could not be saved. This view still uses your previous visit.</p> : null}
  </section>;
  return <PromptsPresentation data={data} expanded={expanded} onToggle={() => setExpanded(!expanded)} importControl={importControl} />;
}
