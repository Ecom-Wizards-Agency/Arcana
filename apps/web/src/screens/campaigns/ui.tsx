import type { ReactNode } from 'react';
export { Button, Input, Select, Textarea, Field } from '../../ui/primitives';

export function Notice({ kind = 'neutral', children }: { kind?: 'neutral' | 'warn' | 'good' | 'bad'; children: ReactNode }) {
  return <div role={kind === 'bad' ? 'alert' : 'status'} style={{ padding: 'var(--wa-space-4, 16px)', background: kind === 'neutral' ? 'var(--wa-surface-2)' : `var(--wa-${kind}-bg)`, borderRadius: 'var(--wa-radius)', color: 'var(--wa-text)' }}>{children}</div>;
}
export function DetailsTable({ headings = ['Setting', 'Value'], rows }: { headings?: string[]; rows: ReactNode[][] }) {
  return <div style={{ overflowX: 'auto' }}><table className="wa-table" style={{ width: '100%' }}><thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
export function CampaignPage({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <main className="wa-page wa-stack campaign-page" aria-label={title}><style>{`
    .campaign-page { max-width:1200px; margin-inline:auto; width:100%; }
    .campaign-page h1 { font-size:28px; letter-spacing:-.025em; margin-block:0 8px; }
    .campaign-page h2 { font-size:20px; margin-block:0 12px; }
    .campaign-page h3 { font-size:16px; }
    .campaign-page .wa-stack { gap:20px; }
    .campaign-page .wa-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .campaign-page section, .campaign-page aside { min-width:0; }
    .campaign-page .wa-table { border-collapse:collapse; font-size:13px; }
    .campaign-page .wa-table th { text-align:left; font-weight:500; color:var(--wa-text-muted); padding:12px 10px; background:var(--wa-surface-2); }
    .campaign-page .wa-table td { padding:13px 10px; border-bottom:1px solid var(--wa-border); vertical-align:top; }
    .campaign-page input, .campaign-page select, .campaign-page textarea { max-width:100%; }
    .campaign-page label { display:block; font-size:13px; }
    .campaign-page label input { margin-top:6px; }
    .campaign-page code { overflow-wrap:anywhere; font-size:12px; }
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
