'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { defaultVisibleColumns, ENTITY_LABELS, minimumColumnWidth, type GridColumn } from '../columns.js';
import type { SavedView } from '../views.js';
import { managerColumnGroups, searchColumns } from './column-groups.js';
import { tokens } from '../theme.js';

export type ColumnLayout = Pick<SavedView, 'columns' | 'pinned' | 'widths' | 'alignments'>;
export interface ColumnManagerProps {
  available: readonly GridColumn[]; view: SavedView; onApply: (layout: ColumnLayout) => void; onClose: () => void;
  onSave?: (name: string, layout: ColumnLayout) => Promise<void>;
  views?: readonly SavedView[]; children?: ReactNode | ((layout: ColumnLayout, change: (layout: ColumnLayout) => void) => ReactNode);
}
const button = { border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.space(2), background: tokens.color.surface, color: tokens.color.text };
const pane = { padding: tokens.space(3), border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, overflow: 'auto', minWidth: 0 };
const layoutOf = (view: ColumnLayout): ColumnLayout => ({ columns: [...view.columns], pinned: [...view.pinned], widths: { ...view.widths }, alignments: { ...view.alignments } });
export function moveChosenColumn(layout: ColumnLayout, id: string, before: string | null, pinned: boolean): ColumnLayout {
  if (!layout.columns.includes(id) || id === before) return layout;
  const columns = layout.columns.filter((item) => item !== id);
  const at = before === null ? columns.length : columns.indexOf(before);
  columns.splice(at < 0 ? columns.length : at, 0, id);
  const pins = layout.pinned.filter((item) => item !== id);
  if (pinned) pins.push(id);
  return { ...layout, columns: [...columns.filter((item) => pins.includes(item)), ...columns.filter((item) => !pins.includes(item))], pinned: pins };
}
export function ColumnManager({ available, view, onApply, onClose, onSave, views = [], children }: ColumnManagerProps) {
  const [layout, setLayout] = useState(() => layoutOf(view));
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState('all');
  const [dragging, setDragging] = useState<string | null>(null);
  const [landing, setLanding] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => managerColumnGroups(available), [available]);
  const filtered = managerColumnGroups(searchColumns(available, query)).filter((group) => subject === 'all' || group.id === subject);
  const reset = (): ColumnLayout => ({ columns: defaultVisibleColumns(view.entity), pinned: available.filter((column) => column.pinned).map((column) => column.id), widths: {}, alignments: {} });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    root.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const commit = async () => {
    if (saving) return;
    if (onSave && name.trim()) {
      setSaving(true); setError(null);
      try { await onSave(name.trim(), layout); }
      catch { setSaving(false); setError('Preset could not be saved. Try again.'); return; }
      setSaving(false);
    }
    onApply(layout); onClose();
  };
  const remove = (id: string) => setLayout((current) => ({ ...current, columns: current.columns.filter((item) => item !== id), pinned: current.pinned.filter((item) => item !== id) }));
  const choose = (ids: readonly string[]) => setLayout((current) => ({ ...current, columns: [...new Set(ids)], pinned: current.pinned.filter((id) => ids.includes(id)) }));
  const dropProps = (before: string | null, pinned: boolean) => ({
    onDragOver: (event: React.DragEvent) => { if (dragging) { event.preventDefault(); setLanding(before ?? (pinned ? 'pinned-end' : 'end')); } },
    onDrop: (event: React.DragEvent) => { event.preventDefault(); if (dragging) setLayout(moveChosenColumn(layout, dragging, before, pinned)); setDragging(null); setLanding(null); },
  });
  return <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Adjust columns" onKeyDown={(event) => {
    if (event.key === 'Escape') onClose();
    if (event.key === 'Tab') { const nodes = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select'); const first = nodes?.[0]; const last = nodes?.[nodes.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }} style={{ position: 'fixed', inset: 0, zIndex: 90, display: 'flex', flexDirection: 'column', background: tokens.color.surface, color: tokens.color.text, padding: tokens.space(5), gap: tokens.space(3), fontSize: tokens.font.size.sm }}>
    <header><h2>Adjust columns</h2><p>{ENTITY_LABELS[view.entity]} · {available.length} columns available, {layout.columns.length} chosen · grouped by what they describe</p></header>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(280px, 2.4fr) minmax(320px, 2.6fr)', gap: tokens.space(3), minHeight: 0, flex: 1 }}>
      <nav aria-label="Column groups" style={{ ...pane, background: tokens.color.surfaceAlt }}><button style={button} onClick={() => setSubject('all')}>All ({available.length})</button>{groups.map((group) => <button key={group.id} aria-pressed={subject === group.id} style={{ ...button, display: 'block', width: '100%', marginTop: tokens.space(2) }} onClick={() => setSubject(group.id)}>{group.label} ({group.columns.length})</button>)}</nav>
      <section style={pane} aria-label="Available columns"><strong>Available · {available.length} · {layout.columns.length} chosen</strong><input style={{ ...button, display: 'block', marginBlock: tokens.space(3), boxSizing: 'border-box', width: '100%' }} aria-label="Search columns" placeholder="Search columns" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button style={button} onClick={() => choose([...layout.columns, ...filtered.flatMap((group) => group.columns.map((column) => column.id))])}>Select all</button>
        <button style={button} onClick={() => choose(available.filter((column) => column.id !== 'translation' || layout.columns.includes('translation')).map((column) => column.id))}>Show all columns</button>
        {view.entity === 'targets' ? <button style={button} onClick={() => choose(available.filter((column) => column.referenceOrder !== undefined).sort((a, b) => a.referenceOrder! - b.referenceOrder!).map((column) => column.id))}>Performance columns</button> : null}
        {typeof children === 'function' ? children(layout, setLayout) : children}
        {filtered.map((group) => <fieldset key={group.id} style={{ border: 0, borderTop: `1px solid ${tokens.color.border}`, marginTop: tokens.space(4) }}><legend>{group.label} ({group.columns.length})</legend>{group.columns.map((column) => <label key={column.id} title={column.description} style={{ display: 'inline-flex', gap: tokens.space(1), margin: tokens.space(1), padding: tokens.space(1), background: layout.columns.includes(column.id) ? tokens.color.indigoSoft : tokens.color.surfaceAlt, borderRadius: tokens.radius.sm }}><input type="checkbox" checked={layout.columns.includes(column.id)} onChange={() => layout.columns.includes(column.id) ? remove(column.id) : choose([...layout.columns, column.id])} />{column.header}{column.measurementStatus === 'needs-ingestion' ? <small>needs ingestion</small> : null}</label>)}</fieldset>)}
        {filtered.length === 0 ? <p>No columns match this search.</p> : null}
      </section>
      <section style={{ ...pane, background: tokens.color.surfaceAlt }} aria-label="Chosen columns"><strong>Chosen · {layout.columns.length}</strong><button style={button} onClick={() => setLayout(reset())}>Reset to default</button><button style={button} onClick={() => choose([])}>Remove all</button>
        {[true, false].map((pinned) => <section key={String(pinned)} aria-label={pinned ? 'Pinned left' : 'Unpinned'} style={{ marginTop: tokens.space(4) }}>
          <h3>{pinned ? 'PINNED LEFT' : 'UNPINNED'} <small>{pinned ? 'stays put while the table scrolls' : 'drag to reorder'}</small></h3>
          {layout.columns.filter((id) => layout.pinned.includes(id) === pinned).map((id, index, section) => {
            const column = available.find((item) => item.id === id); if (!column) return null;
            return <div key={id} data-chosen-column={id} draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', id); setDragging(id); }} onDragEnd={() => { setDragging(null); setLanding(null); }} {...dropProps(id, pinned)}
              style={{ ...button, marginBlock: tokens.space(1), display: 'flex', gap: tokens.space(1), alignItems: 'center', opacity: dragging === id ? .5 : 1, borderTop: landing === id ? `3px solid ${tokens.color.indigo}` : button.border }}>
              {landing === id ? <small data-insertion-line>drop here</small> : null}<span style={{ flex: 1 }}>⋮ {column.header}</span>
              <input type="number" aria-label={`Width ${column.header}`} min={minimumColumnWidth(column)} style={{ width: 56 }} value={layout.widths[id] ?? column.width} onChange={(event) => setLayout({ ...layout, widths: { ...layout.widths, [id]: Math.max(minimumColumnWidth(column), Number(event.target.value)) } })} />
              <select aria-label={`Alignment ${column.header}`} value={layout.alignments?.[id] ?? column.align} onChange={(event) => setLayout({ ...layout, alignments: { ...layout.alignments, [id]: event.target.value as 'left' | 'right' } })}><option value="left">left</option><option value="right">right</option></select>
              <button aria-label={`${pinned ? 'Unpin' : 'Pin'} ${column.header}`} onClick={() => setLayout(moveChosenColumn(layout, id, null, !pinned))}>⌷</button>
              <button aria-label={`Move ${column.header} up`} disabled={index === 0} onClick={() => setLayout(moveChosenColumn(layout, id, section[index - 1]!, pinned))}>↑</button>
              <button aria-label={`Move ${column.header} down`} disabled={index === section.length - 1} onClick={() => setLayout(moveChosenColumn(layout, id, section[index + 2] ?? null, pinned))}>↓</button>
              <button aria-label={`Remove ${column.header}`} onClick={() => remove(id)}>×</button>
            </div>;
          })}
          <div {...dropProps(null, pinned)} data-pin-divider={pinned ? 'true' : undefined} style={{ padding: tokens.space(3), border: `1px dashed ${landing === (pinned ? 'pinned-end' : 'end') ? tokens.color.indigo : tokens.color.border}` }}>{landing === (pinned ? 'pinned-end' : 'end') ? <span data-insertion-line>drop here</span> : pinned ? 'Drop above this divider to pin' : 'Drop here to unpin'}</div>
        </section>)}
      </section>
    </div>
    <footer style={{ display: 'flex', gap: tokens.space(2), alignItems: 'center', flexWrap: 'wrap' }}><span>Preset</span>
      {['Rank review', 'Bid work', 'Audit'].map((preset) => <button key={preset} style={button} onClick={() => {
        const saved = views.find((item) => item.name === preset);
        const columns = preset === 'Audit' ? available.filter((column) => column.id !== 'translation') : available.filter((column) => column.pinned || (preset === 'Rank review' ? column.subject === 'RANK & ORGANIC' || column.subject === 'SQP' : /bid|spend|acos|sales|verdict/.test(column.id)));
        setLayout(saved ? layoutOf(saved) : { ...reset(), columns: columns.map((column) => column.id) }); setName(preset);
      }}>{preset}</button>)}
      <input aria-label="Preset name" placeholder="Preset name" value={name} onChange={(event) => setName(event.target.value)} />
      <button style={button} disabled={!onSave || !name.trim() || saving} onClick={() => { setSaving(true); setError(null); void onSave?.(name.trim(), layout).then(() => setSaving(false), () => { setSaving(false); setError('Preset could not be saved. Try again.'); }); }}>+ Save current</button>
      <span style={{ flex: 1 }}>Presets are saved with this profile.</span>{error ? <span role="alert">{error}</span> : null}
      <button style={button} aria-label="Close controls" disabled={saving} onClick={() => void commit()}>Apply and close</button><button style={button} onClick={onClose}>Cancel</button><button style={button} disabled={saving} onClick={() => void commit()}>Apply</button>
    </footer>
  </div>;
}
