'use client';
import { useRef, useState } from 'react';
import type { ReactNode, ButtonHTMLAttributes } from 'react';
export function ResearchAction({ primary = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" {...props} className={`research-action ${primary ? 'primary' : ''} ${className}`} />;
}
export function ResearchInfo({ label, children, initialOpen = false }: { label: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen), button = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  return <span className="research-info" onMouseEnter={() => setOpen(true)} onMouseLeave={() => {
    if (!document.activeElement?.closest('.research-info')) setOpen(false);
  }}
    onKeyDown={e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    }} onBlur={e => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
    }}>
    <button ref={button} type="button" className="research-action" aria-expanded={open} onClick={() => setOpen(true)}>{label}</button>
    {open ? <span role="dialog" aria-label={label} className="research-popover">{children}<ResearchAction onClick={close}>Close</ResearchAction></span> : null}
  </span>;
}
export async function researchMutation(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result['error'] ?? 'The save could not be confirmed. Reload before trying again.'));
  return result;
}
export const researchMoney = (value: number | null, currency = 'USD') => value === null ? '—' : new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency
}).format(value);
export const researchPercent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
