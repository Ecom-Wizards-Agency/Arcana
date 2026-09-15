'use client';
import { useEffect, useRef, useState } from 'react';
import { SpWriteRestoreExportResult, spWriteRestoreExportConfirmation, type SpWriteRestoreExportPreview } from '@wizard-ads/shared/sp-write-application';
import { OptimizerFrame } from '../optimizer/frame';
import { DataTable, Cell } from '../optimizer-review/components';
import { displayValue } from '../time-machine/model';
import { changeQueueHref } from '../optimizer/navigation';
import styles from '../optimizer/optimizer.module.css';

/** The route owner waits for mounted handlers before accepting notes or export clicks. */
export function RestoreExportScreen({ data, currencyCode }: { data: SpWriteRestoreExportPreview; currencyCode: string }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  return <RestoreExportContent data={data} currencyCode={currencyCode} interactive={hydrated} />;
}

/** Export is reviewed on the same confirmation route and never records write approval. */
export function RestoreExportContent({ data, currencyCode, interactive = true }: { data: SpWriteRestoreExportPreview; currencyCode: string; interactive?: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ rows: number; tag: string; download: string } | null>(null);
  const lock = useRef(false);
  const count = data.preview.readyRows;
  const readyRows = data.preview.rows.filter((row) => row.exportAllowed);
  const excludedCount = data.preview.blockedRows;
  const confirmation = count > 0 ? spWriteRestoreExportConfirmation(count) : 'Export restore proposal (0 changes)';
  async function exportProposal() {
    if (lock.current || !interactive) return;
    if (!note.trim()) { setError('Add a note explaining why these values should be restored.'); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch('/api/time-machine/restore/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profileId: data.profileId, batchId: data.batchId, expectedRows: count, note, confirmation, fingerprint: data.fingerprint,
      }) });
      const parsed = SpWriteRestoreExportResult.safeParse(await response.json());
      if (!response.ok || !parsed.success || parsed.data.rows !== count || parsed.data.sourceBatchId !== data.batchId) throw new Error('The export could not be confirmed. Reload this proposal to check current evidence.');
      setResult({ rows: parsed.data.rows, tag: parsed.data.tag, download: parsed.data.downloads.rows });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The restore proposal could not be exported.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <OptimizerFrame title="Confirm restore proposal" step={3}>
    <p data-testid="restore-source">Restore of batch {data.batchId} · {count} rows</p>
    <section className={styles.warning}><h2>Amazon writes are not enabled for this profile</h2><p>Profile allowlist: not enabled. This action exports the exact inverse values for review.</p><button className={styles.action} disabled aria-label="Amazon apply disabled: profile allowlist is not enabled">Amazon apply unavailable</button></section>
    <DataTable headers={['Row', 'Field', 'Current', 'Restore to']} label="Immutable restore preview">{readyRows.map((row) => <tr key={row.rowId}><Cell>{row.entityName ?? row.entityId}</Cell><Cell>{row.field}</Cell><Cell>{displayValue(row.currentValue, row.field, currencyCode)}<div>Read at {row.currentSyncedAt ?? '—'}</div></Cell><Cell>{displayValue(row.inverseValue, row.field, currencyCode)}</Cell></tr>)}</DataTable>
    <p data-testid="restore-export-excluded">{excludedCount} row{excludedCount === 1 ? '' : 's'} excluded from this export.{excludedCount > 0 ? <> <a href={changeQueueHref(data.profileId, { batch: data.batchId })}>Review excluded rows</a></> : null}</p>
    <p>{data.preview.reason}</p>
    <div className={styles.fields}><label>Restore note<textarea className={styles.search} rows={3} value={note} onChange={(event) => setNote(event.target.value)} disabled={!interactive || busy || result !== null} /></label></div>
    {error ? <p role="alert">{error}</p> : null}
    {result ? <p role="status" data-testid="reversion-result">Exported {result.rows} inverse change{result.rows === 1 ? '' : 's'} as {result.tag}. <a href={result.download}>Download inverse rows JSON</a>. Amazon was not updated.</p> : null}
    <div className={styles.footer}><a href={`/change-queue?profile=${data.profileId}`}>Back to Change queue</a><button className={`${styles.action} ${styles.primary}`} disabled={!interactive || busy || result !== null || !data.preview.exportAllowed || count === 0} onClick={() => { void exportProposal(); }}>{confirmation}</button></div>
  </OptimizerFrame>;
}
