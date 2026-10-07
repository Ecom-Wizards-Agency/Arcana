'use client';
/**
 * One draft's decision controls. Each button moves exactly this draft and
 * nothing else: a POST to `/creators/drafts/[draftId]`. Approving records a
 * decision; the operator sends the text by hand in Amazon. Nothing is sent.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { CreatorDraftStatus } from '@wizard-ads/shared';
import { Badge, Button } from '../../ui/primitives';
import { DRAFT_STATUS_TONE, DRAFT_STATUS_WORDS } from '../creators-daily-queue/creator-frame';

type Move = Exclude<CreatorDraftStatus, 'draft'>;
const LABEL: Record<Move, string> = { approved: 'Approve', sent_by_hand: 'Mark sent by hand', withdrawn: 'Withdraw' };
const DONE: Record<Move, string> = {
  approved: 'Approved. Nothing was sent: send the text by hand in Amazon, then mark it sent by hand.',
  sent_by_hand: 'Marked sent by hand.',
  withdrawn: 'Withdrawn.',
};

export interface DraftDecisionProps {
  draftId: string;
  status: CreatorDraftStatus;
  /** Why each move is unavailable, or null when it is allowed. */
  blocked: Record<Move, string | null>;
}

export function movesFor(status: CreatorDraftStatus): Move[] {
  if (status === 'draft') return ['approved', 'withdrawn'];
  if (status === 'approved') return ['sent_by_hand', 'withdrawn'];
  return [];
}

export function DraftDecision({ draftId, status: initial, blocked }: DraftDecisionProps): ReactNode {
  const router = useRouter();
  const [status, setStatus] = useState<CreatorDraftStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // A refresh brings the stored status; keep the confirmation that nothing was sent.
  useEffect(() => { setStatus(initial); }, [initial]);

  const move = useCallback(async (to: Move) => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/creators/drafts/${draftId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      const payload = (await response.json().catch(() => ({}))) as { draft?: { status?: CreatorDraftStatus }; error?: string };
      if (!response.ok || payload.draft?.status !== to) throw new Error(payload.error ?? response.statusText);
      setStatus(to);
      setDone(DONE[to]);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The draft could not be changed.');
    } finally {
      setBusy(false);
    }
  }, [draftId, router]);

  const moves = movesFor(status);
  const reasons = [...new Set(moves.map((to) => blocked[to]).filter((reason): reason is string => reason !== null))];
  return <div className="wa-stack" style={{ gap: '0.375rem' }} data-testid="draft-decision" data-draft={draftId}>
    <div className="wa-row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
      <span data-testid="draft-status" data-status={status}><Badge tone={DRAFT_STATUS_TONE[status]}>{DRAFT_STATUS_WORDS[status]}</Badge></span>
      {moves.map((to) => <Button key={to} size="sm" variant={to === 'approved' ? 'primary' : to === 'withdrawn' ? 'ghost' : 'default'}
        disabled={busy || blocked[to] !== null} title={blocked[to] ?? undefined} data-move={to} onClick={() => void move(to)}>{LABEL[to]}</Button>)}
    </div>
    {reasons.map((reason) => <p key={reason} className="wa-page-sub" data-testid="draft-disabled-reason">{reason}</p>)}
    {done === null ? null : <p className="wa-page-sub" role="status" data-testid="draft-done">{done}</p>}
    {error === null ? null : <p className="wa-banner wa-banner--bad" role="alert" data-testid="draft-error">{error}</p>}
  </div>;
}
