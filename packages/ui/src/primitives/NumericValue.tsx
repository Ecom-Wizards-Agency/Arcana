'use client';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { tokens } from '../theme.js';

/** Keep the complete formatted value in the DOM and accessible name. */
export function NumericValue({ value, style }: { value: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setClipped(node.scrollWidth > node.clientWidth);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [value]);
  return <span data-numeric-value={value} data-truncated={clipped} title={value} aria-label={value}
    style={{ display: 'flex', minWidth: 0, width: '100%', alignItems: 'center', justifyContent: 'inherit', ...style }}>
    <span ref={ref} style={{ display: 'block', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{value}</span>
    {clipped ? <span data-truncation-marker aria-hidden="true" style={{ flexShrink: 0, color: tokens.color.indigo, paddingLeft: tokens.space(.5) }}>ⓘ</span> : null}
  </span>;
}
