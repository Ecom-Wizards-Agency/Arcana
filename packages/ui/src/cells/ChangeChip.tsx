import type { CSSProperties, ReactNode } from 'react';
export type ChangeChipTone = 'indigo' | 'warn' | 'good' | 'bad' | 'neutral';
/** Change provenance and review state share one token-based cell treatment. */
export function ChangeChip({ children, tone = 'indigo' }: { children: ReactNode; tone?: ChangeChipTone }) {
  const prefix = tone === 'indigo' ? 'info' : tone;
  const style: CSSProperties = { display:'inline-block',borderRadius:6,padding:tone==='neutral'?'2px 7px':'3px 8px',
    fontSize:10,lineHeight:1.2,fontWeight:600,
    color:tone==='neutral'?'var(--wa-text-dim)':`var(--wa-${prefix}-text)`,
    background:tone==='neutral'?'var(--wa-surface-sunken)':`var(--wa-${prefix}-bg)`,
    ...(tone==='neutral'?{border:'1px dashed var(--wa-border-strong)'}:{}),
  };
  return <span style={style}>{children}</span>;
}
