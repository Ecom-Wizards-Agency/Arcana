'use client';
import { useEffect, useRef, useState } from 'react';
import { ChangeChip as Chip } from '../../../../../packages/ui/src/cells/ChangeChip';
import { useRouter } from 'next/navigation';
import { useRefreshShellEvidence } from '../../ui/shell-evidence';
import { ChangeQueueSource, ChangeQueueState, parseGridView, serializeGridView } from '@wizard-ads/shared';
import type { ChangeQueueEntry } from '@wizard-ads/shared';
import { GRID_DENSITIES, DENSITY_LABELS, isGridDensity, rowHeightFor, toCsv } from '@wizard-ads/ui';
import { restoreCounts } from '../../../../../packages/core/src/restore-preview';
import { attribution, displayValue, queueModel, QUEUE_COLUMNS, SOURCE_LABEL } from './model';
import { restoreQueueView, saveQueueView, queueViewStore } from './saved-view';
import type { load } from './load';
import { optimizerBatchHref } from '../optimizer/navigation';
export type ScreenData = Awaited<ReturnType<typeof load>>;
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
  const preview = data.preview;
  if (preview !== null) {
    const counts = restoreCounts(preview.rows);
    return <main className="cq" data-interactive={hydrated?'true':'false'} data-profile-id={data.profileId} data-testid="reversion-preview">
      <header><h1>Restore preview · {/^Batch\s/i.test(preview.label) ? preview.label : `Batch ${preview.label}`}</h1><p>What putting these values back would mean, checked row by row against what the account holds right now.</p></header>
      <div className="cq-table-wrap"><table className="cq-restore"><colgroup>{[250,82,82,82,96,130,234].map((width,i)=><col key={i} style={i===6?undefined:{width}} />)}</colgroup><thead><tr>{['ROW','FIELD','WE SET','NOW','RESTORE TO','STATE','WHY'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{preview.rows.map(row=><tr key={row.rowId} data-testid="reversion-row" data-state={row.state}><td>{row.entity}</td><td>{row.field}</td><td>{displayValue(row.weSet,row.field,data.currencyCode)}</td><td>{displayValue(row.now,row.field,data.currencyCode)}</td><td>{displayValue(row.restoreTo,row.field,data.currencyCode)}</td><td><Chip tone={row.state==='ready'?'good':row.state==='conflict'?'bad':row.state==='already restored'||row.state==='unsupported'?'neutral':'warn'}>{row.state}</Chip></td><td>{row.why}</td></tr>)}</tbody></table></div>
      <div className="cq-counts">{[['ROWS IN BATCH',counts.total],['READY TO RESTORE',counts.ready],['BLOCKED',counts.blocked],['NOTHING TO DO',counts.nothingToDo]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="cq-actions"><button className="cq-primary" disabled={!hydrated||preview.blockedReason!==null||counts.ready===0||saving!==null||!['owner','admin'].includes(data.role)} onClick={()=>void mutateProposal({requestId:requestIdFor(preview.batchId),profileId:data.profileId,applyBatchId:preview.batchId,sourceRowIds:preview.rows.filter(row=>row.state==='ready').map(row=>row.rowId)})}>Build a restore proposal for {counts.ready} rows</button><span>{preview.blockedReason ?? <>The {counts.blocked} blocked rows are left out, not silently forced.</>}</span></div>
      <aside className="cq-explanation"><h2>A restore is a new proposal, not an undo.</h2><p>This builds a fresh batch out of the values we recorded before the change, and it goes through the same review as anything else. Nothing is sent to Amazon from this screen. A row whose current value no longer matches what we set is refused rather than overwritten, because the change we would be reversing is not the last thing that happened to it.</p></aside>
      {message?<p role="alert">{message}</p>:null}<a href={href({batch:null})}>Back to Change queue</a>
    </main>;
  }
  const last = data.entries.at(-1);
  return <main className="cq" data-interactive={hydrated?'true':'false'} data-profile-id={data.profileId}>
    <p>Every change we can see, with the value it had before. One timeline over the batches we exported, the differences we noticed when we next read the account, and queued proposals awaiting review.</p>
    <div className="cq-tools"><details><summary>Filter</summary><form key={['source','state','type','field'].map(key=>data.query[key]??'').join('|')} method="get" aria-label="Filter changes" data-testid="timeline-filters"><input type="hidden" name="profile" value={data.profileId}/><input type="hidden" name="view" value={saveQueueView(data.query)}/>{['from','to','density'].map(key=>data.query[key]?<input key={key} type="hidden" name={key} value={data.query[key]}/>:null)}
      <label>Source<select name="source" defaultValue={data.query['source']??''} data-testid="filter-source"><option value="">All sources</option>{ChangeQueueSource.options.map(s=><option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label>
      <label>State<select name="state" defaultValue={data.query['state']??''}><option value="">All states</option>{ChangeQueueState.options.map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Entity type<input name="type" defaultValue={data.query['type']??''} data-testid="filter-type"/></label><label>Field<input name="field" defaultValue={data.query['field']??''} data-testid="filter-field"/></label><button type="submit">Apply</button>
    </form></details>
    {['source','state','type','field'].map(key=>data.query[key]?<a className="cq-filter-chip" key={key} href={href({[key]:null,before_at:null,before_id:null})}>{key}: {key==='source' && ChangeQueueSource.safeParse(data.query[key]).success ? SOURCE_LABEL[data.query[key] as ChangeQueueEntry['source']] : data.query[key]} ×</a>:null)}
    <a data-testid="filter-clear" href={href({source:null,state:null,type:null,field:null,before_at:null,before_id:null})}>Clear filters</a>
    <label className="cq-density">Density<select aria-label="Density" value={density} onChange={event=>router.push(href({density:event.target.value}))}>{GRID_DENSITIES.map(d=><option key={d} value={d}>{DENSITY_LABELS[d]}</option>)}</select></label>
    <button onClick={()=>{const result=toCsv(model,{columns:QUEUE_COLUMNS,label:'change-queue',currencyCode:data.currencyCode}); if(result.exported!==model.shown) throw new Error('CSV count mismatch'); const url=URL.createObjectURL(new Blob([result.csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=result.filename;a.click();URL.revokeObjectURL(url);}}>Export CSV · {model.exported} rows</button></div>
    {data.partial?<p role="status" className="cq-partial">Some changes are awaiting sync. The mirror has not been read since the last export or linked change.</p>:null}
    {message?<p role="alert">{message}</p>:null}
    {data.cursor?<a data-testid="timeline-newer" href={href({before_at:null,before_id:null})}>Newest changes</a>:null}
    {model.shown===0?<p role="status" data-testid={data.cursor?'timeline-empty-cursor':'timeline-empty-filtered'}>No changes recorded in this range</p>:<div className="cq-table-wrap"><table className="cq-history" style={{'--cq-row-height':`${rowHeightFor(density)+10}px`} as React.CSSProperties}><colgroup>{QUEUE_COLUMNS.map(c=><col key={c.id} style={{width:c.width}}/>)}</colgroup><thead><tr>{QUEUE_COLUMNS.map(c=><th key={c.id}>{c.header}</th>)}</tr></thead><tbody>{model.rows.map(gridRow=>{
      const row=data.entries.find(entry=>entry.id===gridRow.id)!;
      const link=row.source==='apply'&&row.batchId?href({batch:row.batchId}):row.reviewHref;
      return <tr key={row.id} className={link ? 'cq-linked-row' : undefined} onClick={event=>{if(link && !(event.target as Element).closest('a,button,details')) router.push(link);}} data-testid="timeline-entry" data-source={row.source}><td>{new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}).format(new Date(row.when)).replace(',','').replace('Sept','Sep')}</td><td title={row.entity}>{link?<a data-testid="time-machine-batch" title={row.batchLabel ?? undefined} href={link}>{row.entity}</a>:row.entity}</td><td>{row.field}</td><td>{displayValue(row.oldValue,row.field,data.currencyCode)}</td><td>{displayValue(row.newValue,row.field,data.currencyCode)}</td><td data-testid="entry-source"><Chip tone={row.source==='sync'?'warn':'indigo'}>{SOURCE_LABEL[row.source]}</Chip></td><td title={attribution(row)}>{attribution(row)}</td><td><Chip tone={['observed','unattributed'].includes(row.state)?'warn':'indigo'}>{row.state}</Chip>{row.source==='sync'&&row.acknowledgedAt===null&&data.role!=='viewer'?<details className="cq-state-menu"><summary aria-label={`Actions for ${row.entity}`}>⋮</summary><button disabled={!hydrated||saving!==null} onClick={()=>void acknowledge(row)}>Acknowledge</button></details>:null}</td></tr>;
    })}</tbody></table></div>}
    <div className="cq-rules"><aside><h2>“Changed at Amazon” means somebody changed it outside this tool.</h2><p>It is not an error. It is how you find out that a teammate, a rule in Seller Central, or Amazon itself moved something you were about to reason about.</p></aside><aside><h2>A change is only tied to a batch when the match is unambiguous.</h2><p>If two exported rows could both explain the same observed change, it stays unattributed rather than being credited to one of them. Guessing here would corrupt every later count.</p></aside></div>
    {data.hasOlder&&last?<a data-testid="timeline-older" href={href({before_at:last.when,before_id:last.id})}>Older changes</a>:null}
  </main>;
}
