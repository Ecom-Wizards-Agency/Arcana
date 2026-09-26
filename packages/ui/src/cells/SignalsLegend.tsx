'use client';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SIGNAL_AXES } from './signals.js';
import { tokens } from '../theme.js';

/** The legend's width; it opens beside the header, clamped to the viewport. */
const LEGEND_WIDTH = 320;
/** Taller content scrolls inside the popover rather than reaching further over the rows. */
const LEGEND_MAX_HEIGHT = 360;

/**
 * The SIGNALS key, as a compact popover under the column header.
 *
 * It used to open on hover as a 460px panel with generous padding, so passing
 * the pointer over the header covered the first rows of the table (V23). Now it
 * opens only when asked (click, Enter or Space on the header button), keeps
 * every explanation in a dense two-column list, and goes away the way a popover
 * should: Escape, the close button, a press anywhere outside it, or scrolling
 * the page or the grid beneath it (a resize moves it with its header). The
 * header's own tooltip still names the four axes on hover.
 */
export function SignalsLegend() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const place = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (box) setPosition({ top: box.bottom + 4, left: Math.max(8, Math.min(box.left, window.innerWidth - LEGEND_WIDTH - 8)) });
  };
  const show = () => {
    place();
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node
      && (panel.current?.contains(target) === true || trigger.current?.contains(target) === true);
    const dismiss = (event: Event) => { if (!inside(event.target)) setOpen(false); };
    // A resized window moves the header; the popover follows it rather than closing.
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return <span onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(true); } }}>
    <button ref={trigger} type="button" aria-label="SIGNALS legend" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={(event) => { event.stopPropagation(); if (open) close(false); else show(); }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && open) close(true); }}
      style={{ border: 0, background: 'transparent', color: tokens.color.text, font: 'inherit', padding: 0, cursor: 'pointer' }}>SIGNALS ⓘ</button>
    <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'repeat(4,28px)', gap: 4, textAlign: 'center' }}>{SIGNAL_AXES.map((axis) => <small key={axis.key}>{axis.key}</small>)}</span>
    {open ? createPortal(<div ref={panel} id={id} role="dialog" aria-label="SIGNALS legend" data-testid="signals-legend" onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } }}
      style={{ position: 'fixed', top: position.top, left: position.left, width: LEGEND_WIDTH, maxWidth: 'calc(100vw - 16px)', maxHeight: LEGEND_MAX_HEIGHT, overflowY: 'auto', boxSizing: 'border-box', zIndex: 100,
        padding: `${tokens.space(2)} ${tokens.space(3)} ${tokens.space(3)}`, border: `1px solid ${tokens.color.borderStrong}`, borderRadius: tokens.radius.md, background: tokens.color.surfaceAlt, color: tokens.color.text,
        boxShadow: 'var(--wa-shadow-2)', whiteSpace: 'normal', textTransform: 'none', letterSpacing: 'normal', fontSize: tokens.font.size.xs, fontWeight: 400, lineHeight: 1.35 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space(2), marginBottom: tokens.space(1) }}>
        <strong style={{ fontSize: tokens.font.size.sm }}>SIGNALS</strong>
        <button type="button" aria-label="Close legend" onClick={() => close(true)}
          style={{ border: 0, background: 'transparent', color: tokens.color.textMuted, font: 'inherit', fontSize: tokens.font.size.base, lineHeight: 1, padding: tokens.space(1), cursor: 'pointer' }}>×</button>
      </div>
      <p style={{ margin: `0 0 ${tokens.space(2)}` }}>One tile per axis, filling from the bottom on its own scale. It is for scanning many rows; every axis is also its own sortable column.</p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: tokens.space(2), rowGap: tokens.space(1.5), margin: `0 0 ${tokens.space(2)}` }}>
        {SIGNAL_AXES.map((axis) => <Fragment key={axis.key}>
          <dt data-signal-axis={axis.key} style={{ fontWeight: 700 }}>{axis.key}</dt>
          <dd style={{ margin: 0 }}><strong style={{ fontWeight: 600 }}>{axis.label}</strong> ({axis.grain}). {axis.description}</dd>
        </Fragment>)}
      </dl>
      <p style={{ margin: `0 0 ${tokens.space(1)}` }}>Solid underline: daily data. Dashed underline: weekly data, so weekly SQP and daily ads sit side by side without hiding their grain.</p>
      <p style={{ margin: 0 }}>Dotted outline: unknown. It never means zero: Amazon omits zero-impression rows entirely.</p>
    </div>, document.body) : null}
  </span>;
}
