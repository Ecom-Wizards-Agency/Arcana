'use client';
import { useRef, useState } from 'react';
import { EmptyState } from '@wizard-ads/ui';
import { HomeCard } from './card';

export interface HomeProposal {
  id: string; entityLabel: string; scope: string; field: string;
  currentValue: string; proposedValue: string; reason: string;
}

export function ProposalsInbox({ proposals, canDecide, profileId, capped = false }: {
  proposals: readonly HomeProposal[]; canDecide: boolean; profileId: string; capped?: boolean;
}) {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const visible = proposals.filter((row) => !removed.has(row.id));
  async function decide(row: HomeProposal, decision: 'accepted' | 'dismissed') {
    if (!canDecide || pending.current.has(row.id)) return;
    const note = notes[row.id]?.trim() ?? '';
    if (decision === 'dismissed' && note.length === 0) return;
    pending.current.add(row.id);
    setRemoved((previous) => new Set([...previous, row.id]));
    setError(null);
    try {
      const response = await fetch('/api/recommendations/decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [row.id], decision, note: note || null }),
      });
      const result: unknown = await response.json();
      if (!response.ok || typeof result !== 'object' || result === null
        || !('updated' in result) || result.updated !== 1
        || !('offered' in result) || result.offered !== 1
        || !('refused' in result) || !Array.isArray(result.refused) || result.refused.length !== 0) {
        throw new Error('Decision was not confirmed');
      }
    } catch {
      setRemoved((previous) => { const next = new Set(previous); next.delete(row.id); return next; });
      setError(`Could not confirm the decision for ${row.entityLabel}. The proposal is back in your inbox. Review it before retrying.`);
    } finally { pending.current.delete(row.id); }
  }
  return <HomeCard title="Proposals" subtitle="The recommendations queue lives here, with the full review one click away."
    section={{ id: 'proposals', count: visible.length, noun: ['proposal', 'proposals'] }}>
    {capped ? <p className="wa-home-caption">Showing the first {proposals.length} proposals. Open full review to check run counts.</p> : null}
    {error === null ? null : <p role="alert">{error}</p>}
    {visible.length === 0 ? <EmptyState title="No proposals waiting" body="New proposals will appear here after the next recommendation run." /> :
      <ol className="wa-home-proposals" aria-label="Pending proposals">{visible.map((row) => {
        const direction = Number(row.proposedValue) - Number(row.currentValue);
        const tone = row.field === 'bid' && Number.isFinite(direction) ? direction > 0 ? 'good' : direction < 0 ? 'bad' : 'neutral' : 'warn';
        return <li key={row.id} data-tone={tone}>
          <div className="wa-home-proposal-row"><strong className="wa-home-priority">{proposals.indexOf(row) + 1}</strong>
            <div className="wa-home-proposal-copy">
              {canDecide ? <details><summary><strong>{row.entityLabel}</strong><span>{row.reason}</span></summary>
                <div className="wa-home-proposal-actions">
                  <p>{row.scope} · {row.field}: {row.currentValue} → {row.proposedValue}</p>
                  <p>Approval records your decision; applying changes to Amazon requires a separate review.</p>
                  <button className="wa-btn wa-btn--sm" type="button" onClick={() => void decide(row, 'accepted')}>Approve</button>
                  <label>Dismissal reason for {row.entityLabel}<input className="wa-input" value={notes[row.id] ?? ''}
                    onChange={(event) => setNotes((previous) => ({ ...previous, [row.id]: event.target.value }))} /></label>
                  <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" disabled={!notes[row.id]?.trim()}
                    onClick={() => void decide(row, 'dismissed')}>Dismiss</button>
                </div>
              </details> : <><strong>{row.entityLabel}</strong><span>{row.reason}</span></>}
            </div>
            <a className="wa-home-review" href={`/recommendations?profile=${encodeURIComponent(profileId)}`} aria-label={`Review ${row.entityLabel}`}>Review →</a>
          </div>
        </li>;
      })}</ol>}
  </HomeCard>;
}
