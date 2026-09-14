'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TargetTranslation, TRANSLATION_LANGUAGES } from '@wizard-ads/shared';
import { tokens } from '@wizard-ads/ui';
import type { TranslationScreenData } from './load';

export default function TranslationStatusScreen({ data }: { data: TranslationScreenData }) {
  if (data.view === 'gated') return <main><h1>Translation status</h1><p>Choose an authorized account to view translations.</p></main>;
  if (data.view === 'empty') return <main><h1>Translation status</h1><p>Choose a profile to view translations.</p></main>;
  return <StatusRows key={`${data.profileId}:${data.language}`} data={data} />;
}
function StatusRows({ data }: { data: Extract<TranslationScreenData, { view: 'ready' }> }) {
  const abort = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController(); abort.current = current;
    return () => current.abort();
  }, []);
  const [rows, setRows] = useState(data.rows);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setPending('refresh'); setError(null);
    try {
      const response = await fetch(`/api/translation?${new URLSearchParams({ profile: data.profileId, language: data.language })}`, { signal: abort.current.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Translation status could not be loaded');
      const body = await response.json() as { rows: unknown[]; count: number };
      const saved = body.rows.map((row) => TargetTranslation.parse(row));
      if (body.count !== saved.length || saved.some((row) => row.profileId !== data.profileId || row.language !== data.language)) throw new Error('Translation status scope or count mismatch');
      if (!abort.current.signal.aborted) setRows(saved);
    } catch (failure) { if (!abort.current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Translation status unavailable'); }
    finally { if (!abort.current.signal.aborted) setPending(null); }
  };
  const retry = async (translationId: string, expectedRequestId: string) => {
    setPending(translationId); setError(null);
    try {
      const response = await fetch('/api/translation/retry', { method: 'POST', signal: abort.current.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: data.profileId, translationId, expectedRequestId }) });
      if (!response.ok) throw new Error('The retry could not be queued. Reload the status before trying again.');
      const body = await response.json() as { row: unknown; count: number };
      const saved = TargetTranslation.parse(body.row);
      if (body.count !== 1 || saved.id !== translationId || saved.profileId !== data.profileId) throw new Error('Retry confirmation did not match this translation.');
      if (!abort.current.signal.aborted) setRows((current) => current.map((row) => row.id === saved.id ? saved : row));
    } catch (failure) { if (!abort.current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Translation retry failed'); }
    finally { if (!abort.current.signal.aborted) setPending(null); }
  };
  return <main style={{ maxWidth: 1100, color: tokens.color.text }}>
    <h1>Translation status</h1><p>Translation language · {TRANSLATION_LANGUAGES[data.language]}</p>
    <p>You can continue using the original terms while translation is unavailable.</p>
    <button disabled={pending !== null} onClick={() => { void refresh(); }}>Refresh translations</button>
    {error ? <p role="alert">{error}</p> : null}
    {rows.length === 0 ? <p>No translations requested. Add Translation in the column chooser to read targets in another language.</p> : <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{['Original target', 'Translation', 'Status'].map((name) => <th key={name} style={{ textAlign: 'left', padding: 12, borderBottom: `1px solid ${tokens.color.border}` }}>{name}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id} data-testid="translation-status-row">
        <td style={{ padding: 12 }}>{row.originalText}</td>
        <td style={{ padding: 12 }} title={row.result.reason ?? `Provider: ${row.providerId}`}>{row.result.status === 'waiting' ? <span aria-busy="true">Translating…</span> : row.result.status === 'available' ? row.result.text : 'Translation unavailable'}</td>
        <td style={{ padding: 12 }}>{row.result.status === 'waiting' ? 'Waiting' : row.result.status === 'available' ? 'Available' : <button disabled={!data.canRetry || pending !== null} title={row.result.reason} onClick={() => { void retry(row.id, row.provenance.requestId); }}>{pending === row.id ? 'Retrying…' : 'Retry'}</button>}</td>
      </tr>)}</tbody>
    </table>}
    <Link href={`/grid?${new URLSearchParams({ entity: 'targets', profile: data.profileId })}`}>Back to targets</Link>
  </main>;
}
