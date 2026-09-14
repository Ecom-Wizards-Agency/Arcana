'use client';
import { useEffect, useState } from 'react';
import { TargetTranslation, type TranslationLanguage } from '@wizard-ads/shared';
import { DataGrid, type GridRow } from '@wizard-ads/ui';

export function useTranslationColumn(profileId: string, language: TranslationLanguage, enabled: boolean, rows: readonly GridRow[]) {
  const [result, setResult] = useState<{ scope: string; rows: TargetTranslation[]; error: string | null }>({ scope: '', rows: [], error: null });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const scope = `${profileId}:${language}`;
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const run = async () => {
      const response = await fetch(`/api/translation?${new URLSearchParams({ profile: profileId, language })}`, { signal: abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Translation status could not be loaded');
      const payload = await response.json() as { rows?: unknown[]; count?: number };
      if (!Array.isArray(payload.rows) || payload.count !== payload.rows.length) throw new Error('Translation status count mismatch');
      const saved = payload.rows.map((row) => TargetTranslation.parse(row));
      if (abort.signal.aborted) return;
      if (saved.some((row) => row.profileId !== profileId || row.language !== language)) throw new Error('Translation status scope mismatch');
      if (!abort.signal.aborted) setResult({ scope, rows: saved, error: null });
      const existing = new Set(saved.map((row) => row.originalText));
      const missing = [...new Set(rows.flatMap((row) => typeof row.dimensions['targeting'] === 'string' && !existing.has(row.dimensions['targeting']) ? [row.dimensions['targeting']] : []))];
      // Requests preserve exact originals. Sequential admission limits in-flight work.
      for (const originalText of missing) {
        if (abort.signal.aborted) return;
        const queued = await fetch('/api/translation', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, originalText, language }) });
        if (!queued.ok) throw new Error('Translation request could not be queued');
        const body = await queued.json() as { row: unknown; count: number };
        if (body.count !== 1) throw new Error('Translation request count mismatch');
        saved.push(TargetTranslation.parse(body.row));
        if (!abort.signal.aborted) setResult({ scope, rows: [...saved], error: null });
      }
    };
    void run().catch((error: unknown) => { if (!abort.signal.aborted) setResult({ scope, rows: [], error: error instanceof Error ? error.message : 'Translation unavailable' }); });
    return () => abort.abort();
  }, [enabled, language, profileId, rows, scope, refreshVersion]);
  const byText = new Map((result.scope === scope ? result.rows : []).map((row) => [row.originalText, row]));
  const cell = (row: GridRow) => {
    const original = row.dimensions['targeting'];
    const translation = typeof original === 'string' ? byText.get(original) : undefined;
    if (translation?.result.status === 'available') return <span title={`Translated by ${translation.providerId}`}>{translation.result.text}</span>;
    if (translation?.result.status === 'unavailable') return <DataGrid.cells.NotMeasuredCell label="Translation unavailable" reason={translation.result.reason} />;
    if (result.scope === scope && result.error) return <DataGrid.cells.NotMeasuredCell label="Translation unavailable" reason={result.error} />;
    return <span aria-busy="true" title="Waiting for translation">Translating…</span>;
  };
  return { cell, refresh: () => setRefreshVersion((value) => value + 1) };
}
