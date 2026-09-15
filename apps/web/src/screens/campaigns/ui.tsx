import type { ReactNode } from 'react';
export { Button, Input, Select, Textarea, Field, Badge } from '../../ui/primitives';

export function Notice({ kind = 'neutral', children }: { kind?: 'neutral' | 'warn' | 'good' | 'bad'; children: ReactNode }) {
  return <div role={kind === 'bad' ? 'alert' : 'status'} style={{ padding: 'var(--wa-space-4, 16px)', background: kind === 'neutral' ? 'var(--wa-surface-3)' : `var(--wa-${kind}-bg)`, borderRadius: 'var(--wa-radius)', color: 'var(--wa-text)' }}>{children}</div>;
}
export function DetailsTable({ headings = ['Setting', 'Value'], rows }: { headings?: string[]; rows: ReactNode[][] }) {
  return <div style={{ overflowX: 'auto' }}><table className="wa-table" style={{ width: '100%' }}><thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
export function CampaignPage({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <main className="wa-page wa-stack campaign-page" aria-label={title}><style>{`
    .campaign-page { max-width:1200px; margin-inline:auto; width:100%; }
    .campaign-page h1 { font-size:24px; letter-spacing:-.025em; margin-block:0 8px; }
    .campaign-page h2 { font-size:20px; margin-block:0; }
    .campaign-page h3 { font-size:16px; margin:0; }
    .campaign-page p { margin-block:0; }
    .campaign-page .wa-stack { gap:12px; }
    .campaign-page { gap:16px; }
    .campaign-page .wa-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .campaign-page section, .campaign-page aside { min-width:0; }
    .campaign-page .wa-table { border-collapse:collapse; font-size:13px; }
    .campaign-page .wa-table th { text-align:left; font-weight:500; color:var(--wa-text-muted); padding:12px 10px; background:var(--wa-surface-2); }
    .campaign-page .wa-table td { padding:13px 10px; border-bottom:1px solid var(--wa-border); vertical-align:top; }
    .campaign-page input, .campaign-page select, .campaign-page textarea { max-width:100%; }
    .campaign-page label { display:block; font-size:13px; }
    .campaign-page label input { margin-top:6px; }
    .campaign-page code { overflow-wrap:anywhere; font-size:12px; }
    .campaign-ad-types { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .campaign-ad-type { display:block; text-align:left; white-space:normal; font-weight:400; line-height:1.5; padding:12px; align-self:start; }
    .campaign-builder-layout > aside[aria-label="Settings"] { gap:8px; border:0; }
    .campaign-builder-layout > aside[aria-label="Settings"] > label, .campaign-builder-layout > aside[aria-label="Settings"] > div { padding:8px; background:var(--wa-surface-2); border:1px solid var(--wa-border); border-radius:var(--wa-radius); }
    .campaign-builder-layout > aside[aria-label="Settings"] input, .campaign-builder-layout > aside[aria-label="Settings"] select { padding:2px 0; border:0; background:transparent; font-size:11px; }
    .campaign-stepper { display:flex; gap:8px; }
    .campaign-stepper [role="tab"] { flex:1; border:0; background:var(--wa-surface); border-radius:var(--wa-radius-pill); font-size:12px; padding:10px 8px; }
    .campaign-stepper [aria-selected="true"] { background:var(--wa-accent-soft); color:var(--wa-accent); }
    .campaign-plan-counts { display:grid; gap:12px; }
    .campaign-plan-counts strong { font-size:24px; margin-right:8px; }
    .campaign-plan-counts span { color:var(--wa-text-muted); font-size:12px; }
    .campaign-check-chip[data-runnable="true"] .wa-badge { color:var(--wa-good-text); background:var(--wa-good-bg); }
    .campaign-check-chip[data-runnable="false"] .wa-badge { border:1px dotted var(--wa-text-muted); }
    .campaign-rationale { border:1px solid var(--wa-border); border-radius:var(--wa-radius); padding:16px; background:var(--wa-surface-2); }
    .campaign-rationale blockquote { margin:8px 0; }
    .campaign-bid-rows { margin:0; }
    .campaign-bid-rows > div { display:flex; justify-content:space-between; gap:24px; padding:8px 0; border-bottom:1px solid var(--wa-border); }
    .campaign-bid-rows dd { margin:0; text-align:right; font-weight:600; }
    .campaign-bid-rows small { display:block; color:var(--wa-text-muted); }
    .campaign-builder-layout { display:grid; grid-template-columns:120px minmax(0,1fr) 300px; gap:24px; align-items:start; }
    .campaign-builder-layout aside { border:1px solid var(--wa-border); border-radius:var(--wa-radius); }
    .campaign-builder-layout aside small { color:var(--wa-text-muted); font-size:10px; letter-spacing:.07em; }
    .campaign-builder-layout aside p { margin-block:6px; }
    .campaign-builder-layout aside .wa-table td { padding:9px 2px; }
    @media(max-width:1100px) { .campaign-builder-layout { grid-template-columns:120px minmax(0,1fr); } .campaign-builder-layout aside:last-child { grid-column:2; } }
    @media(max-width:640px) { .campaign-builder-layout { grid-template-columns:minmax(0,1fr); } .campaign-builder-layout aside:first-child { position:static!important; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); } .campaign-builder-layout aside:last-child { grid-column:1; } .campaign-page dialog { inset:5%!important; max-width:90%!important; overflow:auto; } }
  `}</style><header><h1>{title}</h1>{subtitle && <p className="wa-hint">{subtitle}</p>}</header>{children}</main>;
}
export function money(value: number | null | undefined, currency: string): string {
  return value == null ? 'Not measured' : new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
}
export const NO_ROLLBACK_NOTE = 'Amazon resources created here cannot be deleted from this screen. Pausing or archiving them later is a separate reviewed action.';

export function quantity(count: number, singular: string, plural = `${singular}s`): string { return `${count} ${count === 1 ? singular : plural}`; }
