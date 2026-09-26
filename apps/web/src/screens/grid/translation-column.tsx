'use client';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { TargetTranslation, type TranslationLanguage } from '@wizard-ads/shared';
import type { GridRow } from '@wizard-ads/ui';
import { translatablePhrase } from './translation-column-scope';

const faint = { color: 'var(--wa-text-faint)' } as const;
const bad = { color: 'var(--wa-bad-text)' } as const;

export function useTranslationColumn(profileId: string, language: TranslationLanguage, enabled: boolean, rows: readonly GridRow[]) {
  const [result, setResult] = useState<{ scope: string; rows: TargetTranslation[]; error: string | null }>({ scope: '', rows: [], error: null });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const scope = `${profileId}:${language}`;
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const saved: TargetTranslation[] = [];
    const run = async () => {
      const response = await fetch(`/api/translation?${new URLSearchParams({ profile: profileId, language })}`, { signal: abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Translation status could not be loaded');
      const payload = await response.json() as { rows?: unknown[]; count?: number };
      if (!Array.isArray(payload.rows) || payload.count !== payload.rows.length) throw new Error('Translation status count mismatch');
      const loaded = payload.rows.map((row) => TargetTranslation.parse(row));
      if (abort.signal.aborted) return;
      if (loaded.some((row) => row.profileId !== profileId || row.language !== language)) throw new Error('Translation status scope mismatch');
      saved.push(...loaded);
      if (!abort.signal.aborted) setResult({ scope, rows: [...saved], error: null });
      const existing = new Set(saved.map((row) => row.originalText));
      // Keyword phrases only; product targets, expressions, ASINs and ids are never sent.
      const missing = [...new Set(rows.flatMap((row) => {
        const phrase = translatablePhrase(row.dimensions);
        return phrase !== null && !existing.has(phrase) ? [phrase] : [];
      }))];
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
    // A failure keeps every translation already loaded; the cells still waiting show the error.
    void run().catch((error: unknown) => { if (!abort.signal.aborted) setResult({ scope, rows: [...saved], error: error instanceof Error ? error.message : 'Translation unavailable' }); });
    return () => abort.abort();
  }, [enabled, language, profileId, rows, scope, refreshVersion]);
  const current = useMemo(() => result.scope === scope ? result : { scope, rows: [] as TargetTranslation[], error: null }, [result, scope]);
  const byText = useMemo(() => new Map(current.rows.map((row) => [row.originalText, row])), [current.rows]);
  const cell = useCallback((row: GridRow): ReactNode => {
    const phrase = translatablePhrase(row.dimensions);
    if (phrase === null) return <span data-translation-state="not-keyword" title="Only keyword phrases are translated. Product targets, automatic targets and codes keep their original wording." style={faint}>Keywords only</span>;
    const translation = byText.get(phrase);
    if (translation?.result.status === 'available') return <span data-translation-state="translated" title={`Translated by ${translation.providerId}`}>{translation.result.text}</span>;
    if (translation?.result.status === 'unavailable') return <span data-translation-state="failed" title={translation.result.reason} style={bad}>Translation unavailable: {translation.result.reason}</span>;
    if (current.error !== null) return <span data-translation-state="failed" title={current.error} style={bad}>Translation unavailable: {current.error}</span>;
    return <span data-translation-state="pending" aria-busy="true" title={translation === undefined ? 'Queueing for translation' : 'Queued; waiting for the translation provider'} style={faint}>Translating…</span>;
  }, [byText, current.error]);
  /** One line for the whole column: the load or queue error, or how many translations failed. */
  const failure = useMemo((): string | null => {
    if (current.error !== null) return `Translations stopped: ${current.error}`;
    const shown = new Set(rows.flatMap((row) => { const phrase = translatablePhrase(row.dimensions); return phrase === null ? [] : [phrase]; }));
    const failed = current.rows.filter((row) => row.result.status === 'unavailable' && shown.has(row.originalText));
    if (failed.length === 0) return null;
    const reasons = [...new Set(failed.map((row) => row.result.reason))];
    return `${failed.length} ${failed.length === 1 ? 'translation' : 'translations'} unavailable: ${reasons.join('; ')}`;
  }, [current.error, current.rows, rows]);
  return { cell, failure, refresh: () => setRefreshVersion((value) => value + 1) };
}

/** The column's failure, shown once next to the Translation status link. Renders nothing without a failure. */
export function TranslationFailureNotice({ failure }: { failure: string | null }): ReactNode {
  return failure === null ? null : <span role="alert" data-testid="translation-failure" style={{ ...bad, fontSize: 11 }}>{failure}</span>;
}
