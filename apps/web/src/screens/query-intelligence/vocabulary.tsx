'use client';
import { useState } from 'react';
import { QueryVocabularyKind, QueryVocabularyEntry } from '@wizard-ads/shared';
import { ResearchAction, researchMutation } from './research-ui';
export function VocabularyEditor({ profileId, entries: initial, onChange }: { profileId: string; entries: QueryVocabularyEntry[]; onChange?: (entries: QueryVocabularyEntry[]) => void }) {
  const [entries, setEntries] = useState(initial), [kind, setKind] = useState<QueryVocabularyKind>('own_brand_term'), [value, setValue] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function change(action: 'add' | 'approve' | 'remove', id?: string) {
    setBusy(true);
    setError('');
    try {
      const result = await researchMutation('/api/query-intelligence/vocabulary', action === 'add' ? {
        action,
        profileId,
        kind,
        value
      } : {
        action,
        profileId,
        id
      });
      const next = QueryVocabularyEntry.array().parse(result['entries']);
      if (next.length !== result['count']) throw new Error('Vocabulary count mismatch');
      setEntries(next);
      onChange?.(next);
      if (action === 'add') setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vocabulary could not be saved');
    } finally {
      setBusy(false);
    }
  }
  return <section aria-label="Query vocabulary" className="research-card"><h2>Vocabulary</h2><p className="muted">Add and approve words for this marketplace. Only approved entries affect classification.</p>
    <div className="research-actions"><label className="research-field">Kind<select value={kind} onChange={e => setKind(QueryVocabularyKind.parse(e.target.value))}>{QueryVocabularyKind.options.map(k => <option key={k} value={k}>{k.replaceAll('_', ' ')}</option>)}</select></label>
      <label className="research-field">Word or phrase<input value={value} onChange={e => setValue(e.target.value)} /></label><ResearchAction disabled={busy || !value.trim()} onClick={() => void change('add')}>Add word</ResearchAction></div>
    {error ? <p role="alert">{error}</p> : null}<div className="research-table-scroll"><table className="research-table"><thead><tr><th>Kind</th><th>Word</th><th>Source</th><th>Approval</th><th>Reviewed</th><th>Actions</th></tr></thead><tbody>
      {entries.map(e => <tr key={e.id ?? `${e.kind}:${e.normalizedValue}`}><td>{e.kind.replaceAll('_', ' ')}</td><td>{e.value}</td><td>{e.source.replaceAll('_', ' ')}</td><td>{e.approved ? 'Approved' : 'Pending'}</td><td>{e.reviewedAt ?? '—'}</td><td>{!e.approved ? <ResearchAction disabled={busy} onClick={() => void change('approve', e.id)}>Approve {e.value}</ResearchAction> : null} <ResearchAction disabled={busy} onClick={() => void change('remove', e.id)}>Remove {e.value}</ResearchAction></td></tr>)}
    </tbody></table></div>{!entries.length ? <p>No vocabulary yet.</p> : null}</section>;
}
