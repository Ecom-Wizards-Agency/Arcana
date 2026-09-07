'use client';

/**
 * Three columns, ordered by votes, with the vote toggle on the card.
 *
 * The order comes from the server (the query sorts on the vote count), and a
 * vote cast here updates the count in place rather than resorting under the
 * reader's cursor: a list that reorders while you are clicking it is how a
 * second vote lands on the wrong card. The new order is what the next load
 * shows.
 */
import { useEffect, useRef, useState } from 'react';
import { FeedbackCommandResult } from '@wizard-ads/shared';
import { FeedbackTriageControls } from '../../src/feedback/triage-controls';
import type { FeedbackTriageChanges } from '../../src/feedback/triage-controls';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { banner, button, colors, heading, muted, page } from '../../src/ui/tokens';

interface BoardProps {
  planned: UiFeedbackItem[];
  inProgress: UiFeedbackItem[];
  shipped: UiFeedbackItem[];
  declined: UiFeedbackItem[];
  canTriage: boolean;
}

type ColumnKey = 'planned' | 'inProgress' | 'shipped';

const COLUMNS: { key: ColumnKey; title: string; testId: string }[] = [
  { key: 'planned', title: 'Planned', testId: 'column-planned' },
  { key: 'inProgress', title: 'In progress', testId: 'column-in-progress' },
  { key: 'shipped', title: 'Shipped', testId: 'column-shipped' },
];

export function RoadmapBoardView(initial: BoardProps) {
  const [board, setBoard] = useState<BoardProps>(initial);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  const pendingVotes = useRef(new Set<string>());
  const [voteStates, setVoteStates] = useState<Record<string, 'pending' | 'unconfirmed'>>({});
  useEffect(() => setReady(true), []);

  const vote = async (item: UiFeedbackItem) => {
    if (pendingVotes.current.has(item.id)) return;
    pendingVotes.current.add(item.id);
    setVoteStates((current) => ({ ...current, [item.id]: 'pending' }));
    setMessage('');
    const finish = () => {
      pendingVotes.current.delete(item.id);
      setVoteStates((current) => { const next = { ...current }; delete next[item.id]; return next; });
    };
    const apply = (saved: { voted: boolean; votes: number }) => {
      const update = (items: UiFeedbackItem[]) => items.map((row) => row.id === item.id
        ? { ...row, votes: saved.votes, viewerHasVoted: saved.voted } : row);
      setBoard((current) => ({ ...current, planned: update(current.planned), inProgress: update(current.inProgress),
        shipped: update(current.shipped), declined: update(current.declined) }));
    };
    try {
      const response = await fetch(`/api/feedback/${item.id}/vote`, { method: 'POST' });
      const payload: unknown = await response.json().catch(() => null);
      const saved = voteReadback(payload, item.id, false);
      if (response.ok && saved !== null) { apply(saved); finish(); return; }
      if (response.status >= 400 && response.status < 500) {
        setMessage('The vote was refused. Reload to check your access to this item.');
        finish(); return;
      }
    } catch { /* A network failure does not establish whether the toggle committed. */ }
    setMessage('Checking the saved vote…');
    try {
      const response = await fetch(`/api/feedback/${item.id}`, { cache: 'no-store' });
      const saved = voteReadback(await response.json().catch(() => null), item.id, true);
      if (response.ok && saved !== null) {
        apply(saved);
        setVoteStates((current) => ({ ...current, [item.id]: 'unconfirmed' }));
        setMessage('Showing the current saved vote. The change is still unconfirmed; reload before voting again.');
        return;
      }
    } catch { /* Keep the item blocked until a server reload can reconcile it. */ }
    setVoteStates((current) => ({ ...current, [item.id]: 'unconfirmed' }));
    setMessage('The vote could not be confirmed. Reload to check its saved state.');
  };

  // A GET reports current state; it does not prove that a particular POST committed.
  function voteReadback(value: unknown, itemId: string, fromItem: boolean) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    let candidate: unknown = { ...payload, kind: 'vote' };
    if (fromItem) {
      const item = payload['item'];
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      candidate = { kind: 'vote', itemId: row['id'], voted: row['viewerHasVoted'], votes: row['votes'] };
    }
    const parsed = FeedbackCommandResult.safeParse(candidate);
    return parsed.success && parsed.data.kind === 'vote' && parsed.data.itemId === itemId ? parsed.data : null;
  }

  const triage = async (item: UiFeedbackItem, changes: FeedbackTriageChanges): Promise<void> => {
    setMessage('');
    try {
      const response = await fetch(`/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const payload = (await response.json().catch(() => null)) as {
        item?: Partial<UiFeedbackItem>;
        error?: string;
      } | null;
      if (!response.ok || !payload?.item) {
        throw new Error(payload?.error ?? `Update failed (${response.status})`);
      }
      setBoard((current) => regroupRoadmap(current, { ...item, ...payload.item }));
      setMessage('Saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Update failed');
    }
  };

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Roadmap</h1>
      <p style={muted}>
        Feature requests, ordered by votes. A card moves only when an admin changes its status.{' '}
        <a href="/feedback/new?type=feature" style={button}>
          Request a feature
        </a>
      </p>
      {message && (
        <p role="status" style={banner(message === 'Saved' ? 'good' : 'bad')}>
          {message}
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
          marginTop: '1rem',
        }}
      >
        {COLUMNS.map((column) => {
          const items = board[column.key];
          return (
            <section
              key={column.key}
              aria-label={column.title}
              data-testid={column.testId}
              style={{
                background: colors.subtle,
                border: `1px solid ${colors.border}`,
                borderRadius: '0.5rem',
                minWidth: 0,
                overflow: 'hidden',
                padding: '0.75rem',
              }}
            >
              <h2 style={{ fontSize: '0.9375rem', margin: '0 0 0.5rem' }}>
                {column.title} <span style={muted}>({items.length})</span>
              </h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items.map((item) => (
                  <RoadmapCard
                    key={item.id}
                    item={item}
                    onVote={vote}
                    onTriage={triage}
                    canTriage={initial.canTriage}
                    voteState={voteStates[item.id]}
                  />
                ))}
              </ul>
              {items.length === 0 && <p style={muted}>Nothing here yet.</p>}
            </section>
          );
        })}
      </div>

      <details style={{ marginTop: '1.5rem' }} data-testid="not-planned">
        <summary style={{ cursor: 'pointer', fontSize: '0.9375rem' }}>
          Not planned ({board.declined.length})
        </summary>
        <ul style={{ listStyle: 'none', margin: '0.75rem 0 0', padding: 0 }}>
          {board.declined.map((item) => (
            <RoadmapCard
              key={item.id}
              item={item}
              onVote={vote}
              onTriage={triage}
              canTriage={initial.canTriage}
              voteState={voteStates[item.id]}
              declined
            />
          ))}
        </ul>
        {board.declined.length === 0 && <p style={muted}>Nothing has been declined.</p>}
      </details>
    </main>
  );
}

function RoadmapCard({
  item,
  onVote,
  onTriage,
  canTriage,
  declined = false,
  voteState,
}: {
  item: UiFeedbackItem;
  onVote: (item: UiFeedbackItem) => Promise<void>;
  onTriage: (item: UiFeedbackItem, changes: FeedbackTriageChanges) => Promise<void>;
  canTriage: boolean;
  declined?: boolean;
  voteState?: 'pending' | 'unconfirmed' | undefined;
}) {
  return (
    <li
      id={`roadmap-${item.id}`}
      data-testid={declined ? 'declined-card' : 'roadmap-card'}
      data-item-id={item.id}
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: '0.375rem',
        marginBottom: '0.5rem',
        padding: '0.625rem 0.75rem',
      }}
    >
      <div style={{ alignItems: 'baseline', display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          aria-label={`Vote for ${item.title}`}
          data-testid="vote-button"
          disabled={voteState !== undefined}
          aria-busy={voteState === 'pending'}
          onClick={() => void onVote(item)}
          style={{
            ...button,
            background: item.viewerHasVoted ? colors.goodBg : colors.subtle,
            minWidth: '3.25rem',
          }}
        >
          ▲ <span data-testid="vote-count">{item.votes}</span>
        </button>
        <strong style={{ fontSize: '0.875rem' }}>{item.title}</strong>
      </div>
      {item.body ? (
        <p style={{ fontSize: '0.875rem', margin: '0.375rem 0 0', whiteSpace: 'pre-wrap' }}>
          {item.body}
        </p>
      ) : null}
      <p style={{ ...muted, margin: '0.375rem 0 0' }} data-testid="declined-note">
        {item.adminNote ?? (declined ? 'No reason recorded yet.' : 'No admin note.')}
      </p>
      {canTriage ? (
        <FeedbackTriageControls item={item} onSave={onTriage} />
      ) : (
        <p style={{ ...muted, margin: '0.5rem 0 0' }} data-testid="triage-readonly">
          Only an owner or admin can triage a feature request.
        </p>
      )}
    </li>
  );
}

function regroupRoadmap(current: BoardProps, saved: UiFeedbackItem): BoardProps {
  const byId = new Map<string, UiFeedbackItem>();
  for (const row of [
    ...current.planned,
    ...current.inProgress,
    ...current.shipped,
    ...current.declined,
  ]) {
    byId.set(row.id, row.id === saved.id ? saved : row);
  }
  byId.set(saved.id, saved);
  const items = [...byId.values()];
  return {
    canTriage: current.canTriage,
    planned: items.filter(
      (row) => row.status === 'planned' || row.status === 'new' || row.status === 'triaged',
    ),
    inProgress: items.filter((row) => row.status === 'in_progress'),
    shipped: items.filter((row) => row.status === 'shipped'),
    declined: items.filter((row) => row.status === 'declined'),
  };
}
