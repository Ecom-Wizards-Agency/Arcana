'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './styles.module.css';

/** Hover content stays open across trigger/content; Escape returns trigger focus. */
export function Info({ label, children, align = 'start' }: { label: string; children: ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <span className={styles.popoverRoot} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button type="button" ref={trigger} className={styles.action} aria-label={label} aria-expanded={open} aria-controls={id} disabled={!hydrated}
      onClick={() => setOpen(true)}>ⓘ</button>
    {open ? <span id={id} role="dialog" aria-label={label} data-align={align} className={styles.popover}>{children}</span> : null}
  </span>;
}
