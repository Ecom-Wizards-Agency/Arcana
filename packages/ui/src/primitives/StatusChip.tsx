import type { CSSProperties, ReactNode } from 'react';

export type StatusChipState = 'working' | 'needs-data' | 'idea' | 'run-by-hand';
const states = {
  working: { label: 'Working', tone: 'neutral', color: 'var(--wa-good-text)' },
  'needs-data': { label: 'Needs data', tone: 'warn', color: 'var(--wa-warn-text)' },
  idea: { label: 'Idea', tone: 'dim', color: 'var(--wa-text-dim)' },
  'run-by-hand': { label: 'Run by hand', tone: 'manual', color: '#8E6013' },
} as const;
/**
 * `Chip · Run by hand` from the design file, token for token: radius 7, padding
 * 7/2, 10px semi-bold, white fill, 1px solid #C6C7C9, text #8E6013. Solid, never
 * dashed; a dashed border means "destination undecided".
 */
const runByHand: CSSProperties = {
  background: '#FFFFFF', border: '1px solid #C6C7C9', borderRadius: 7, color: '#8E6013', display: 'inline-flex',
  fontSize: 10, fontWeight: 600, lineHeight: '14px', padding: '2px 7px', whiteSpace: 'nowrap',
};

export function StatusChip({ status, title }: { status: StatusChipState; title?: string }): ReactNode {
  const state = states[status];
  if (status === 'run-by-hand') return <span data-status={status} data-tone={state.tone} title={title} style={runByHand}>{state.label}</span>;
  return <span className={`wa-badge${state.tone === 'warn' ? ' wa-badge--warn' : ''}`} data-status={status} data-tone={state.tone}
    title={title} style={{ color: state.color }}>{state.label}</span>;
}
