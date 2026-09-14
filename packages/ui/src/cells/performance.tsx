import type { CSSProperties, ReactNode } from 'react';
import type { PerformanceVerdict } from '@wizard-ads/shared';
import { deltaColor, tokens } from '../theme.js';

export function NotMeasuredCell({ reason, label = '—' }: { reason: string; label?: string }): ReactNode {
  return <span title={reason} aria-label={`${label === '—' ? 'Not measured' : label}: ${reason}`} style={{ color: tokens.color.textFaint }}>{label}</span>;
}
export const SIGNALS_TOOLTIP = 'R: organic rank; T: top-of-search impression share; I: SQP impression share; P: SQP purchase share. Filled means measured; a dashed outline means not measured.';
export function SignalsCell({ axes }: { axes: readonly { key: 'R' | 'T' | 'I' | 'P'; value: number | null; reason: string }[] }): ReactNode {
  return <span aria-label="Signals" style={{ display: 'inline-flex', gap: 4 }}>
    {(['R', 'T', 'I', 'P'] as const).map((key) => {
      const axis = axes.find((item) => item.key === key);
      const value = axis?.value ?? null;
      const strength = value === null ? 0 : key === 'R' ? 1 / Math.log2(value + 1) : Math.min(1, Math.max(0, value));
      return <span key={key} data-axis={key} data-measured={value !== null} aria-label={key} title={value === null ? axis?.reason ?? 'Not measured' : `${key}: ${key === 'R' ? value : `${(value * 100).toFixed(1)}%`}`}
        style={{ position: 'relative', width: 28, height: 24, boxSizing: 'border-box', display: 'inline-block', overflow: 'hidden', borderRadius: 2,
          border: value === null ? `1px dashed ${tokens.color.textMuted}` : `1px solid ${tokens.color.border}`,
          background: value === null ? 'transparent' : tokens.color.surfaceHover }}>
        {value === null ? null : <span aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.max(4, Math.min(1, strength) * 100)}%`, background: key === 'R' ? tokens.color.indigo : key === 'T' ? tokens.color.accent : tokens.color.good }} />}
      </span>;
    })}
  </span>;
}

/** Rank bands are display constants, independent of strategy and bid decisions. */
export function rankBand(rank: number | null): string {
  if (rank === null) return 'unranked';
  if (rank <= 3) return 'leading';
  if (rank <= 10) return 'first';
  if (rank <= 20) return 'second';
  if (rank <= 50) return 'lower';
  return 'distant';
}
export function RankGridCell({ days, reason }: { days: readonly { date: string; observed: boolean; rank: number | null }[]; reason: string }): ReactNode {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  const neverRanked = sorted.some((day) => day.observed) && sorted.every((day) => day.rank === null);
  return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
    <span aria-label="Organic rank, oldest day first" style={{ display: 'inline-flex', gap: 1 }}>
      {sorted.map((day) => {
        const band = rankBand(day.rank);
        const background = !day.observed ? tokens.color.surfaceHover : band === 'leading' ? tokens.color.goodBorder : band === 'first' ? tokens.color.goodSoft : band === 'second' ? tokens.color.indigoSoft : band === 'lower' ? tokens.color.warnSoft : tokens.color.surfaceAlt;
        return <span key={day.date} data-rank-day={day.date} data-observed={day.observed} data-band={band}
          title={`${day.date}: ${!day.observed ? reason : day.rank === null ? 'Observed, did not rank' : `organic rank ${day.rank}`}`}
          style={{ width: 16, height: 16, boxSizing: 'border-box', textAlign: 'center', fontSize: 9, lineHeight: '14px', border: `1px solid ${tokens.color.border}`, background, color: tokens.color.text }}>{day.rank ?? '—'}</span>;
      })}
    </span>
    {neverRanked ? <span style={{ fontSize: 9, color: tokens.color.textMuted }}>never ranked</span> : null}
  </span>;
}
export function VerdictCell({ verdict }: { verdict: PerformanceVerdict }): ReactNode {
  const tone = verdict.diagnosis === 'Efficient' ? 'good' : verdict.diagnosis === 'Insufficient evidence' ? 'muted' : 'warn';
  const style: CSSProperties = { display: 'inline-block', borderRadius: 5, padding: '3px 6px', fontSize: 10, whiteSpace: 'nowrap',
    background: tone === 'good' ? tokens.color.goodSoft : tone === 'warn' ? tokens.color.warnSoft : tokens.color.surfaceAlt,
    color: tone === 'good' ? tokens.color.good : tone === 'warn' ? tokens.color.warn : tokens.color.textMuted };
  return <span title={verdict.reason} style={style}>{verdict.diagnosis}</span>;
}
export function DeltaCell({ value, suffix = '', better = null }: { value: number | null; suffix?: string; better?: 'higher' | 'lower' | null }): ReactNode {
  return value === null ? <NotMeasuredCell reason="Comparison not measured" /> : <span style={{ color: deltaColor(value, better), fontVariantNumeric: 'tabular-nums' }}>{value > 0 ? '+' : ''}{Number(value.toFixed(1))}{suffix}</span>;
}
export function NotTheQueryChip(): ReactNode {
  return <span title="This target can match other search queries; its performance is not evidence for this literal wording." style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, color: tokens.color.textMuted, background: tokens.color.surfaceHover }}>not the query</span>;
}
