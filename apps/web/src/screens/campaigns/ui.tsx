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
    .campaign-page { max-width:1200px; margin-inline:auto; width:100%; font-size:13px; line-height:1.45; }
    .campaign-page h1 { font-size:20px; letter-spacing:-.025em; margin-block:0 8px; }
    .campaign-page h2 { font-size:16px; margin-block:0; }
    .campaign-page h3 { font-size:14px; margin:0; }
    .campaign-page p { margin-block:0; }
    .campaign-page .wa-stack { gap:12px; }
    .campaign-page { gap:16px; }
    .campaign-page .wa-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .campaign-page section, .campaign-page aside { min-width:0; }
    .campaign-page .wa-table { border-collapse:collapse; font-size:13px; border:1px solid var(--wa-border); }
    .campaign-page .wa-table th { text-align:left; font-weight:600; font-size:12px; text-transform:none; letter-spacing:normal; color:var(--wa-text-muted); padding:12px; background:var(--wa-surface); }
    .campaign-page .wa-table td { padding:12px; border-bottom:1px solid var(--wa-border); vertical-align:top; }
    .campaign-page input, .campaign-page select, .campaign-page textarea { max-width:100%; }
    .campaign-page label { display:block; font-size:13px; }
    .campaign-page label input { margin-top:6px; }
    .campaign-page code { overflow-wrap:anywhere; font-size:12px; }
    .campaign-ad-types { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
    .campaign-ad-type { display:block; text-align:left; white-space:normal; font-weight:400; line-height:1.4; padding:10px; font-size:12px; align-self:start; }
    .campaign-builder-layout > aside[aria-label="Settings"] { gap:8px; border:0; }
    .campaign-builder-layout > aside[aria-label="Settings"] > label, .campaign-builder-layout > aside[aria-label="Settings"] > div { padding:8px; background:var(--wa-surface-2); border:1px solid var(--wa-border); border-radius:var(--wa-radius); }
    .campaign-builder-layout > aside[aria-label="Settings"] input, .campaign-builder-layout > aside[aria-label="Settings"] select { padding:2px 0; border:0; background:transparent; font-size:11px; }
    .campaign-builder-layout > aside[aria-label="Settings"] > label, .campaign-builder-layout > aside[aria-label="Settings"] > div { padding:6px; }
    .campaign-builder-layout > aside[aria-label="Settings"] small { font-size:9px; line-height:1.3; letter-spacing:.03em; }
    .campaign-builder-layout > aside[aria-label="Settings"] p { font-size:12px; line-height:1.3; margin:2px 0; }
    .campaign-builder-layout > aside[aria-label="Settings"] input, .campaign-builder-layout > aside[aria-label="Settings"] select { height:20px; margin:0; padding:0; }
    .campaign-plan-details { margin:0; font-size:12px; }
    .campaign-plan-details > div { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; }
    .campaign-plan-details dt { color:var(--wa-text-muted); }
    .campaign-plan-details dd { margin:0; text-align:right; }
    .campaign-plan-note { font-size:12px; }
    .campaign-product-filters { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
    .campaign-money-control { display:flex; align-items:center; gap:2px; }
    .campaign-stepper { display:flex; gap:8px; }
    .campaign-stepper [role="tab"] { flex:1; border:0; background:var(--wa-surface); border-radius:var(--wa-radius); font-size:12px; padding:10px 8px; }
    .campaign-stepper [aria-selected="true"] { background:var(--wa-indigo-soft); color:var(--wa-indigo); }
    .campaign-plan-counts { display:grid; gap:8px; line-height:1.2; }
    .campaign-plan-counts strong { font-size:24px; margin-right:8px; }
    .campaign-plan-counts span { color:var(--wa-text-muted); font-size:12px; }
    .campaign-check-chip[data-runnable="true"] .wa-badge { color:var(--wa-good-text); background:var(--wa-good-bg); }
    .campaign-check-chip[data-runnable="false"] .wa-badge { border:1px dotted var(--wa-text-muted); }
    .campaign-rationale { border:1px solid var(--wa-border); border-radius:var(--wa-radius); padding:12px; background:var(--wa-surface); }
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
    .campaign-page .wa-btn { font-size:12px; padding:8px 12px; min-height:32px; }
    .campaign-page .wa-btn--primary:not(:disabled) { background:var(--wa-accent); }
    .campaign-page .wa-input, .campaign-page .wa-select, .campaign-page .wa-textarea { background:var(--wa-surface-2); font-size:13px; }
    .campaign-page .wa-input[aria-invalid="true"] { border-color:var(--wa-bad); }
    .campaign-page .wa-badge { border-radius:var(--wa-radius-sm); font-size:11px; }
    .campaign-page [role="tab"][aria-selected="true"], .campaign-page .campaign-filter[aria-pressed="true"] { background:var(--wa-indigo-soft); color:var(--wa-indigo); }
    .campaign-page .campaign-source-tabs [aria-selected="true"] { background:var(--wa-text); color:var(--wa-text-invert); }
    .campaign-plays { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
    .campaign-page .campaign-play { display:block; white-space:normal; text-align:left; padding:10px; font-weight:400; align-self:start; }
    .campaign-play p { margin:6px 0; font-size:12px; }
    .campaign-play .wa-hint { font-size:11px; display:block; }
    .campaign-play[aria-pressed="true"] { border-color:var(--wa-accent); box-shadow:inset 0 0 0 1px var(--wa-accent); }
    .campaign-source-tabs .wa-btn { font-size:11px; padding:6px 8px; }
    .campaign-keyword-candidates { max-height:70px; overflow:auto; }
    .campaign-structure { padding:10px 12px; background:var(--wa-surface); border-radius:var(--wa-radius); }
    .campaign-structure .wa-select { background:transparent; border:0; padding:0; font-weight:600; width:100%; }
    .campaign-structure p { font-size:12px; color:var(--wa-text-muted); margin-top:4px; }
    .campaign-live-preview { background:var(--wa-text); color:var(--wa-text-invert); padding:12px 14px; border-radius:var(--wa-radius); }
    .campaign-live-preview > p:first-of-type { margin:4px 0 8px; font-weight:600; }
    .campaign-live-preview > small { display:block; font-size:10px; }
    .campaign-live-preview > p:last-of-type:not(:first-of-type) { display:inline; font-size:11px; }
    .campaign-reverse-action { display:inline-block; margin-right:8px; padding:3px 8px; font-size:11px; color:var(--wa-on-accent); background:var(--wa-accent); border-radius:var(--wa-radius-sm); text-decoration:none; }
    .campaign-bid-secondary > summary, .campaign-targets summary { color:var(--wa-text-muted); cursor:pointer; }
    .campaign-bid-evidence .wa-badge { background:var(--wa-surface); border:0; }
    .campaign-page .campaign-section-label { font-size:11px; text-transform:uppercase; color:var(--wa-text-muted); font-weight:500; }
    .campaign-convention { display:flex; justify-content:space-between; align-items:center; gap:12px; border:1px solid var(--wa-border); padding:12px; border-radius:var(--wa-radius); }
    .campaign-naming-tokens .wa-badge { background:var(--wa-indigo-soft); color:var(--wa-indigo); border:0; }
    .campaign-asset-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,260px)); gap:16px; }
    .campaign-asset-card { display:flex; flex-direction:column; gap:8px; padding:12px; border:1px solid var(--wa-border); border-radius:var(--wa-radius); background:var(--wa-surface-2); }
    .campaign-asset-thumbnail { height:112px; display:grid; place-items:center; background:var(--wa-surface); color:var(--wa-text-muted); font-size:12px; border-radius:var(--wa-radius-sm); }
    .campaign-asset-thumbnail img { max-height:112px; max-width:100%; }
    .campaign-asset-toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px; }
    @media(max-width:1100px) { .campaign-builder-layout { grid-template-columns:120px minmax(0,1fr); } .campaign-builder-layout aside:last-child { grid-column:2; } }
    @media(max-width:640px) { .campaign-ad-types, .campaign-plays { grid-template-columns:repeat(2,minmax(0,1fr)); } .campaign-convention { flex-wrap:wrap; } .campaign-builder-layout { grid-template-columns:minmax(0,1fr); } .campaign-builder-layout aside:first-child { position:static!important; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); } .campaign-builder-layout aside:last-child { grid-column:1; } .campaign-page dialog { inset:5%!important; max-width:90%!important; overflow:auto; } }
  `}</style><header><h1>{title}</h1>{subtitle && <p className="wa-hint">{subtitle}</p>}</header>{children}</main>;
}
export function money(value: number | null | undefined, currency: string): string {
  return value == null ? 'Not measured' : new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
}
export const NO_ROLLBACK_NOTE = 'Amazon resources created here cannot be deleted from this screen. Pausing or archiving them later is a separate reviewed action.';

export function quantity(count: number, singular: string, plural = `${singular}s`): string { return `${count} ${count === 1 ? singular : plural}`; }

/** Currency with calculation precision; the ordinary money helper remains the rounded display. */
export function exactMoney(value: number | null | undefined, currency: string): string {
  return value == null ? 'Not measured' : new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 6 }).format(value);
}
export function exposureEquation(bid: number, topOfSearch: number, audience: number, currency: string): string {
  const multiplier = 1 + topOfSearch / 100;
  const value = bid * multiplier * (1 + audience / 100);
  return `${money(bid, currency)} × ${multiplier}${audience === 0 ? '' : ` × ${1 + audience / 100}`} = ${exactMoney(value, currency)}${exactMoney(value, currency) === money(value, currency) ? '' : ` → ${money(value, currency)} rounded`}`;
}
