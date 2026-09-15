'use client';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, ButtonHTMLAttributes } from 'react';
export function ResearchAction({ primary = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" {...props} className={`research-action ${primary ? 'primary' : ''} ${className}`} />;
}
export function ResearchSegmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return <div role="group" aria-label={label} className="research-segmented">{options.map(option => <button
    key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
  >{option.label}</button>)}</div>;
}
export function ResearchMenu({ label, disabled, options }: {
  label: string; disabled?: boolean; options: readonly { label: string; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLSpanElement>(null);
  function close(returnFocus = true) { setOpen(false); if (returnFocus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function show() {
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 240)), top: Math.min(rect.bottom + 4, window.innerHeight - options.length * 40 - 16) });
    setOpen(true);
  }
  return <span className="research-menu" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }}><button type="button" className="research-action quiet" ref={trigger} aria-label={label}
    disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : show()}
    onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(); } }}
  >change <span aria-hidden="true">▾</span></button>{open ? <span role="menu" aria-label={label} ref={menu}
    className="research-menu-panel" style={position} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}
    onKeyDown={event => {
      if (event.key === 'Tab') { trigger.current?.focus(); close(false); return; }
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
      if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
    }}>{options.map(option => <button type="button" role="menuitem" tabIndex={-1} key={option.label} onClick={() => { close(); option.onSelect(); }}>{option.label}</button>)}</span> : null}</span>;
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
export const researchExactMoney = (value: number, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, maximumFractionDigits: 12,
}).format(value);
