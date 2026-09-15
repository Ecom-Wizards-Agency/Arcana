'use client';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SIGNAL_AXES } from './signals.js';
import { tokens } from '../theme.js';
export function SignalsLegend() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const show = () => { const box = trigger.current?.getBoundingClientRect(); if (box) setPosition({ top: box.bottom, left: Math.max(0, Math.min(box.left, window.innerWidth - 460)) }); setOpen(true); };
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <span onMouseEnter={show} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" aria-label="SIGNALS legend" aria-expanded={open} aria-controls={id} onClick={(event) => { event.stopPropagation(); show(); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') close(); }}
      style={{ border: 0, background: 'transparent', color: tokens.color.text, font: 'inherit' }}>SIGNALS ⓘ</button>
    <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'repeat(4,28px)', gap: 4, textAlign: 'center' }}>{SIGNAL_AXES.map((axis) => <small key={axis.key}>{axis.key}</small>)}</span>
    {open ? createPortal(<div id={id} role="dialog" aria-label="SIGNALS legend" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
      style={{ position: 'fixed', ...position, width: 'min(460px, 95vw)', boxSizing: 'border-box', zIndex: 100, padding: tokens.space(5), border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, background: tokens.color.surface, color: tokens.color.text, boxShadow: 'var(--wa-shadow)', whiteSpace: 'normal', fontSize: tokens.font.size.sm }}>
      <h3>SIGNALS</h3><p>Four tiles, one per axis, each filling from the bottom on its own scale. The glyph is for scanning 200 rows; every axis also exists as its own sortable column.</p>
      {SIGNAL_AXES.map((axis) => <p key={axis.key}><strong>{axis.key} · {axis.label}</strong> ({axis.grain})<br />{axis.description}</p>)}
      <p>A solid underline means daily data, a dashed one means weekly, so weekly SQP and daily ads can sit side by side without hiding their grain.</p>
      <p>A dotted outline means unknown. It never means zero: Amazon omits zero-impression rows entirely.</p><button onClick={close}>Close legend</button>
    </div>, document.body) : null}
  </span>;
}
