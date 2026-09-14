import type { ReactNode } from 'react';

export type StatusChipState = 'working' | 'needs-data' | 'idea';
const states = {
  working: { label: 'Working', tone: 'neutral', color: 'var(--wa-good-text)' },
  'needs-data': { label: 'Needs data', tone: 'warn', color: 'var(--wa-warn-text)' },
  idea: { label: 'Idea', tone: 'dim', color: 'var(--wa-text-dim)' },
} as const;

export function StatusChip({ status }: { status: StatusChipState }): ReactNode {
  const state = states[status];
  return <span className={`wa-badge${state.tone === 'warn' ? ' wa-badge--warn' : ''}`} data-status={status} data-tone={state.tone}
    style={{ color: state.color }}>{state.label}</span>;
}
