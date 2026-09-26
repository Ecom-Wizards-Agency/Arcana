'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { ChangeChip as Chip } from '../../../../../packages/ui/src/cells/ChangeChip';
import { useRouter } from 'next/navigation';
import { useRefreshShellEvidence } from '../../ui/shell-evidence';
import { ChangeQueueSource, ChangeQueueState, parseGridView, serializeGridView } from '@wizard-ads/shared';
import type { ChangeQueueEntry } from '@wizard-ads/shared';
import { GRID_DENSITIES, DENSITY_LABELS, isGridDensity, rowHeightFor, toCsv } from '@wizard-ads/ui';
import { restoreCounts } from '../../../../../packages/core/src/restore-preview';
import { attribution, displayValue, gridLink, OWNER_DEFINITION, queueModel, QUEUE_COLUMNS, restorable, SOURCE_DETAIL, SOURCE_LABEL, sourceWords, words } from './model';
import { restoreQueueView, saveQueueView, queueViewStore } from './saved-view';
import type { load } from './load';
import { optimizerBatchHref } from '../optimizer/navigation';
export type ScreenData = Awaited<ReturnType<typeof load>>;
const FILTER_KEYS = ['source','state','type','field'] as const;
type FilterKey = typeof FILTER_KEYS[number];
const FILTER_NAMES: Record<FilterKey,string> = { source: 'Source', state: 'State', type: 'Entity type', field: 'Field' };
/** The value the server applies for a filter, or '' when the URL value is absent or ignored. */
function filterValue(query: Record<string,string>, key: FilterKey): string {
  const value = query[key] ?? '';
  if (key === 'source') return ChangeQueueSource.safeParse(value).success ? value : '';
  if (key === 'state') return ChangeQueueState.safeParse(value).success ? value : '';
  return value;
}
function filterValueWords(key: FilterKey, value: string): string {
  if (key === 'source') { const parsed = ChangeQueueSource.safeParse(value); return parsed.success ? sourceWords(parsed.data) : value; }
  return key === 'field' ? value : words(value);
}
/** Restore preview widths; the value columns hold a full currency amount. WHY takes the rest. */
const RESTORE_WIDTHS = [250,82,120,120,120,130,null] as const;
type MenuItem = { label: string; href: string } | { label: string; run: () => void; disabled?: boolean };
/** A row's actions: a menu button with pointer and keyboard support that closes on Escape and outside click. */
export function RowMenu({ label, items, disabled }: { label: string; items: readonly MenuItem[]; disabled: boolean }) {
  const [open,setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const entries = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  const focusAt = (index: number) => { const list = entries(); if (list.length > 0) list[(index + list.length) % list.length]!.focus(); };
  useEffect(() => {
    if (!open) return;
    focusAt(0);
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = root.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inside) trigger.current?.focus();
    };
    document.addEventListener('mousedown', outside); document.addEventListener('touchstart', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('touchstart', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const onMenuKey = (event: React.KeyboardEvent) => {
    const list = entries(), index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusAt(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusAt(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusAt(0); }
    else if (event.key === 'End') { event.preventDefault(); focusAt(list.length - 1); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return <div className="cq-row-menu" ref={root}>
    <button ref={trigger} id={`${id}-trigger`} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} disabled={disabled}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}>⋮</button>
    {open ? <div role="menu" id={`${id}-menu`} aria-labelledby={`${id}-trigger`} ref={menu} onKeyDown={onMenuKey}>{items.map(item => 'href' in item
      ? <a key={item.label} role="menuitem" href={item.href} onClick={() => setOpen(false)}>{item.label}</a>
      : <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { setOpen(false); trigger.current?.focus(); item.run(); }}>{item.label}</button>)}</div> : null}
  </div>;
}
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'empty') return <main className="cq"><p role="status">No changes recorded in this range</p><p>This organisation has no advertising profiles yet.</p></main>;
  if (data.view === 'error') return <main className="cq"><p role="alert">{data.props.message}</p></main>;
  return <Queue data={data.props} />;
}
function Queue({ data }: { data: Extract<ScreenData,{view:'ready'}>['props'] }) {
  const router = useRouter();
  const proposalRequestIds=useRef(new Map<string,string>());
  const requestIdFor=(batchId:string)=>{const existing=proposalRequestIds.current.get(batchId);if(existing) return existing;const id=crypto.randomUUID();proposalRequestIds.current.set(batchId,id);return id;};
  const refreshShell = useRefreshShellEvidence();
  const [message,setMessage] = useState<string | null>(null);
  const [notice,setNotice] = useState<string | null>(null);
  const [saving,setSaving] = useState<string | null>(null);
  const [hydrated,setHydrated] = useState(false);
  useEffect(()=>setHydrated(true),[]);
  useEffect(() => {
    if(data.proposal!==null || data.preview!==null) return;
    try {
      const store=queueViewStore(localStorage,data.viewActor);
      const cached=store.cachedLayout('targets');
      const restored = restoreQueueView(data.query, cached ? serializeGridView(cached) : null);
      if (restored['view'] !== data.query['view']) { router.replace(`/change-queue?${new URLSearchParams(restored)}`); return; }
      void store.rememberLayout(parseGridView(saveQueueView(data.query))!);
    } catch { /* Browser storage is optional. */ }
  }, [data.viewActor, data.query, data.proposal, data.preview, router]);
  const density = isGridDensity(data.query['density']) ? data.query['density'] : 'normal';
  const model = queueModel(data.entries,data.currencyCode);
  const href = (changes: Record<string,string | null>) => {
    const params = new URLSearchParams({ ...data.query, profile: data.profileId });
    for (const [key,value] of Object.entries(changes)) { if (value === null) params.delete(key); else params.set(key,value); }
    const savedQuery = Object.fromEntries(params);
    delete savedQuery['view'];
    params.set('view',saveQueueView(savedQuery));
    return `/change-queue?${params}`;
  };
  const acknowledge = async (row: ChangeQueueEntry) => {
    setSaving(row.id); setMessage(null);
    try {
      const response = await fetch('/api/time-machine/acknowledge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profileId:data.profileId,changeId:row.id.slice(7)})});
      const receipt: unknown = await response.json();
      if (!response.ok || receipt === null || typeof receipt !== 'object'
        || !('acknowledged' in receipt) || receipt.acknowledged !== 1) {
        throw new Error('Acknowledgement could not be confirmed. Reload before trying again.');
      }
      refreshShell();
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Acknowledgement unavailable'); }
    finally { setSaving(null); }
  };
  const mutateProposal = async (body:unknown) => {
    setSaving('proposal');setMessage(null);
    try {
      const response=await fetch('/api/time-machine/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const receipt:unknown=await response.json();
      if (!response.ok || !receipt || typeof receipt !== 'object') throw new Error('The proposal could not be confirmed. Reload the preview before trying again.');
      const sourceBatchId = data.preview?.batchId;
      if (!sourceBatchId) throw new Error('The source batch is unavailable.');
      const destination = 'kind' in receipt && receipt.kind === 'export_only' && 'batchId' in receipt && receipt.batchId === sourceBatchId
        ? optimizerBatchHref('confirm', sourceBatchId, data.profileId, { restoreExport: '1' })
        : 'planId' in receipt && typeof receipt.planId === 'string'
          ? optimizerBatchHref('confirm', sourceBatchId, data.profileId, { plan: receipt.planId }) : null;
      if (!destination) throw new Error('The proposal response identifies another source.');
      refreshShell();router.push(destination);
    } catch(error) {setMessage(error instanceof Error ? error.message : 'Proposal unavailable');}
    finally {setSaving(null);}
  };
  const copyId = async (row: ChangeQueueEntry) => {
    setMessage(null); setNotice(null);
    try { await navigator.clipboard.writeText(row.id); setNotice(`Copied change ID ${row.id}.`); }
    catch { setMessage(`The change ID could not be copied. It is ${row.id}.`); }
  };
  const menuItems = (row: ChangeQueueEntry): MenuItem[] => {
    const items: MenuItem[] = [];
    // The batch view on this screen is its restore preview, so a batch row opens the batch through that one link.
    if (restorable(row)) items.push({ label: 'Start restore preview', href: href({ batch: row.batchId! }) });
    else if (row.reviewHref) items.push({ label: 'Open review', href: row.reviewHref });
    items.push({ label: 'Copy change ID', run: () => void copyId(row) });
    const grid = gridLink(row, data.profileId);
    if (grid !== null) items.push(grid);
    if (row.source === 'sync' && row.acknowledgedAt === null && data.role !== 'viewer') items.push({ label: 'Acknowledge', run: () => void acknowledge(row), disabled: saving !== null });
    return items;
  };
  const preview = data.preview;
  if (preview !== null) {
    const counts = restoreCounts(preview.rows);
    return <main className="cq" data-interactive={hydrated?'true':'false'} data-profile-id={data.profileId} data-testid="reversion-preview">
      <header><h1>Restore preview · {/^Batch\s/i.test(preview.label) ? preview.label : `Batch ${preview.label}`}</h1><p>What putting these values back would mean, checked row by row against what the account holds right now.</p></header>
      <div className="cq-table-wrap"><table className="cq-restore"><colgroup>{RESTORE_WIDTHS.map((width,i)=><col key={i} style={width===null?undefined:{width}} />)}</colgroup><thead><tr>{['ROW','FIELD','WE SET','NOW','RESTORE TO','STATE','WHY'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{preview.rows.map(row=><tr key={row.rowId} data-testid="reversion-row" data-state={row.state}><td>{row.entity}</td><td>{row.field}</td><td className="cq-value">{displayValue(row.weSet,row.field,data.currencyCode)}</td><td className="cq-value">{displayValue(row.now,row.field,data.currencyCode)}</td><td className="cq-value">{displayValue(row.restoreTo,row.field,data.currencyCode)}</td><td><Chip tone={row.state==='ready'?'good':row.state==='conflict'?'bad':row.state==='already restored'||row.state==='unsupported'?'neutral':'warn'}>{row.state.replaceAll('_',' ')}</Chip></td><td>{row.why}</td></tr>)}</tbody></table></div>
      <div className="cq-counts">{[['ROWS IN BATCH',counts.total],['READY TO RESTORE',counts.ready],['BLOCKED',counts.blocked],['NOTHING TO DO',counts.nothingToDo]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="cq-actions"><button className="cq-primary" disabled={!hydrated||preview.blockedReason!==null||counts.ready===0||saving!==null||!['owner','admin'].includes(data.role)} onClick={()=>void mutateProposal({requestId:requestIdFor(preview.batchId),profileId:data.profileId,applyBatchId:preview.batchId,sourceRowIds:preview.rows.filter(row=>row.state==='ready').map(row=>row.rowId)})}>Build a restore proposal for {counts.ready} rows</button><span>{preview.blockedReason ?? <>The {counts.blocked} blocked rows are left out, not silently forced.</>}</span></div>
      <aside className="cq-explanation"><h2>A restore is a new proposal, not an undo.</h2><p>This builds a fresh batch out of the values we recorded before the change, and it goes through the same review as anything else. Nothing is sent to Amazon from this screen. A row whose current value no longer matches what we set is refused rather than overwritten, because the change we would be reversing is not the last thing that happened to it.</p></aside>
      {message?<p role="alert">{message}</p>:null}<a href={href({batch:null})}>Back to Change queue</a>
    </main>;
  }
  const last = data.entries.at(-1);
  const active = FILTER_KEYS.filter(key=>filterValue(data.query,key) !== '');
  const optionsFor = (key: 'type' | 'field') => {
    const values = new Set(key==='type'?data.filterOptions.types:data.filterOptions.fields);
    const current = filterValue(data.query,key);
    if (current) values.add(current);
    return [...values].sort((a,b)=>a.localeCompare(b));
  };
  const chipText = (key: FilterKey) => `${FILTER_NAMES[key]}: ${filterValueWords(key,filterValue(data.query,key))}`;
  const applyFilter = (key: FilterKey, value: string) => router.push(href({[key]:value===''?null:value,before_at:null,before_id:null}));
  const ranged = Boolean(data.query['from'] || data.query['to']);
  return <main className="cq" data-interactive={hydrated?'true':'false'} data-profile-id={data.profileId}>
    <p>Every change we can see, with the value it had before. One timeline over the batches we exported, the differences we noticed when we next read the account, and queued proposals awaiting review.</p>
    <div className="cq-tools">
      <div className="cq-filters" role="group" aria-label="Filter changes" data-testid="timeline-filters">
        <label>Source<select value={filterValue(data.query,'source')} disabled={!hydrated} onChange={event=>applyFilter('source',event.target.value)} data-testid="filter-source"><option value="">All sources</option>{ChangeQueueSource.options.map(s=><option key={s} value={s}>{sourceWords(s)}</option>)}</select></label>
        <label>State<select value={filterValue(data.query,'state')} disabled={!hydrated} onChange={event=>applyFilter('state',event.target.value)} data-testid="filter-state"><option value="">All states</option>{ChangeQueueState.options.map(s=><option key={s} value={s}>{words(s)}</option>)}</select></label>
        <label>Entity type<select value={filterValue(data.query,'type')} disabled={!hydrated} onChange={event=>applyFilter('type',event.target.value)} data-testid="filter-type"><option value="">All entity types</option>{optionsFor('type').map(s=><option key={s} value={s}>{words(s)}</option>)}</select></label>
        <label>Field<select value={filterValue(data.query,'field')} disabled={!hydrated} onChange={event=>applyFilter('field',event.target.value)} data-testid="filter-field"><option value="">All fields</option>{optionsFor('field').map(s=><option key={s} value={s}>{s}</option>)}</select></label>
      </div>
      <label className="cq-density">Density<select aria-label="Density" value={density} onChange={event=>router.push(href({density:event.target.value}))}>{GRID_DENSITIES.map(d=><option key={d} value={d}>{DENSITY_LABELS[d]}</option>)}</select></label>
      <button onClick={()=>{const result=toCsv(model,{columns:QUEUE_COLUMNS,label:'change-queue',currencyCode:data.currencyCode}); if(result.exported!==model.shown) throw new Error('CSV count mismatch'); const url=URL.createObjectURL(new Blob([result.csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=result.filename;a.click();URL.revokeObjectURL(url);}}>Export CSV · {model.exported} rows</button></div>
    {active.length>0?<div className="cq-chips" data-testid="filter-chips">{active.map(key=><a className="cq-filter-chip" data-testid="filter-chip" key={key} aria-label={`Remove filter ${chipText(key)}`} href={href({[key]:null,before_at:null,before_id:null})}>{chipText(key)} ×</a>)}
      <a data-testid="filter-clear" href={href({source:null,state:null,type:null,field:null,before_at:null,before_id:null})}>Clear filters</a></div>:null}
    {data.partial?<p role="status" className="cq-partial">Some changes are awaiting sync. The mirror has not been read since the last export or linked change.</p>:null}
    {message?<p role="alert">{message}</p>:null}
    {notice?<p role="status" data-testid="row-menu-notice">{notice}</p>:null}
    {data.cursor?<a data-testid="timeline-newer" href={href({before_at:null,before_id:null})}>Newest changes</a>:null}
    <p className="cq-owner-help" data-testid="owner-definition">{OWNER_DEFINITION}</p>
    {model.shown===0?<p role="status" data-testid={data.cursor?'timeline-empty-cursor':'timeline-empty-filtered'}>{data.cursor||active.length===0?'No changes recorded in this range':`No changes match ${active.length===1?'this filter':'these filters'}: ${active.map(key=>`${FILTER_NAMES[key]} is ${filterValueWords(key,filterValue(data.query,key))}`).join(', ')}${ranged?' in this date range':''}. Remove ${active.length===1?'it':'one'} to see more changes.`}</p>:<div className="cq-table-wrap"><table className="cq-history" style={{'--cq-row-height':`${rowHeightFor(density)+10}px`} as React.CSSProperties}><colgroup>{QUEUE_COLUMNS.map(c=><col key={c.id} style={{width:c.width}}/>)}</colgroup><thead><tr>{QUEUE_COLUMNS.map(c=><th key={c.id} title={c.id==='attribution'?OWNER_DEFINITION:undefined}>{c.header}</th>)}</tr></thead><tbody>{model.rows.map(gridRow=>{
      const row=data.entries.find(entry=>entry.id===gridRow.id)!;
      const link=row.source==='apply'&&row.batchId?href({batch:row.batchId}):row.reviewHref;
      const detail=SOURCE_DETAIL[row.source];
      return <tr key={row.id} className={link ? 'cq-linked-row' : undefined} onClick={event=>{if(link && !(event.target as Element).closest('a,button,details,.cq-row-menu')) router.push(link);}} data-testid="timeline-entry" data-source={row.source}>
        <td>{new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}).format(new Date(row.when)).replace(',','').replace('Sept','Sep')}</td>
        <td title={row.entity}>{link?<a data-testid="time-machine-batch" title={row.batchLabel ?? undefined} href={link}>{row.entity}</a>:row.entity}{row.source==='amazon'&&row.amazonObservation?<small data-testid="amazon-observation-provenance" style={{display:'block',whiteSpace:'normal',lineHeight:1.4}}>{row.amazonObservation.marketplaceId} · {row.amazonObservation.resolution}{row.amazonObservation.resolvedAmazonId?` to ${row.amazonObservation.resolvedEntityType} ${row.amazonObservation.resolvedAmazonId}`:''}{row.amazonObservation.identityConflict?' · identity conflict':''}</small>:null}
        </td>
        <td>{row.field}</td>
        <td className="cq-value" data-testid="entry-was">{displayValue(row.oldValue,row.field,data.currencyCode)}</td>
        <td className="cq-value" data-testid="entry-became">{displayValue(row.newValue,row.field,data.currencyCode)}</td>
        <td data-testid="entry-source" title={sourceWords(row.source)}><Chip tone={row.source==='sync'?'warn':'indigo'}>{SOURCE_LABEL[row.source]}</Chip>{detail?<span className="cq-source-detail"> · {detail}</span>:null}
          {row.source==='amazon'?<small style={{display:'block',whiteSpace:'normal',lineHeight:1.4}}>Derived identity · provider ID unavailable</small>:null}
        </td>
        <td title={attribution(row)}>{attribution(row)}</td>
        <td>{row.source==='amazon'?null:<RowMenu label={`Actions for ${row.entity}`} disabled={!hydrated} items={menuItems(row)} />}
          <Chip tone={['observed','unattributed'].includes(row.state)?'warn':'indigo'}>{words(row.state)}</Chip></td>
      </tr>;
    })}</tbody></table></div>}
    <div className="cq-rules"><aside><h2>“Ads console” marks a change we saw at Amazon that Arcana did not send.</h2><p>It is not an error. It is how you find out that a teammate in the console, a rule in Seller Central, or Amazon itself moved something you were about to reason about. “Other” is Amazon provider history with no known actor.</p></aside><aside><h2>A change is only tied to a batch when the match is unambiguous.</h2><p>If two exported rows could both explain the same observed change, it stays unattributed rather than being credited to one of them. Guessing here would corrupt every later count.</p></aside></div>
    {data.hasOlder&&last?<a data-testid="timeline-older" href={href({before_at:last.when,before_id:last.id})}>Older changes</a>:null}
  </main>;
}
