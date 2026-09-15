'use client';
import { useState } from 'react';
import { OPTIMIZATION_METHOD_CATALOGUE } from '@wizard-ads/core';
import { MethodSelection, type MethodCatalogueEntry } from '@wizard-ads/shared';
import { Info } from './info';
import styles from './styles.module.css';

export function availability(state: MethodCatalogueEntry['releaseState']): string {
  return state === 'shadow' ? 'Shadow only' : state[0]!.toUpperCase() + state.slice(1);
}
export function MethodPicker({ selection, onSelect }: { selection: MethodSelection; onSelect: (selection: MethodSelection) => void }) {
  const [current, setCurrent] = useState(selection);
  const entry = OPTIMIZATION_METHOD_CATALOGUE.find((method) => method.id === current.id)!;
  return <section aria-label="Choose an optimization method" className={styles.panel}>
    <h2>{entry.displayName}</h2><p>{entry.purpose}</p>
    {entry.releaseState === 'shadow' ? <p>Shadow preview only. This method cannot send changes to Amazon.</p> : null}
    <div className={styles.actions}><button type="button" className={`${styles.action} ${styles.primary}`} onClick={() => onSelect(current)}>Use {entry.displayName}</button>
      <Info label={`About ${entry.displayName}`}><MethodInformation entry={entry} /></Info></div>
    <CatalogueTable onChoose={setCurrent} />
  </section>;
}
export function MethodInformation({ entry }: { entry: MethodCatalogueEntry }) {
  return <><strong>{entry.displayName}</strong><p>{entry.purpose}</p><p>{entry.id} · {entry.version}</p>
    <p>{availability(entry.releaseState)} · {entry.adProducts.join(', ')} · {entry.controls.join(', ')}</p>
    <p>{entry.requiredEvidence.join('; ')}</p>{entry.releaseState === 'shadow' ? <p>Preview only. Sending is unavailable.</p> : null}</>;
}
export function CatalogueTable({ onChoose }: { onChoose?: (selection: MethodSelection) => void }) {
  return <table className={styles.table}><thead><tr><th>Method</th><th>Purpose / Changes</th><th>Availability</th><th><span className={styles.muted}>Details</span></th></tr></thead>
    <tbody>{OPTIMIZATION_METHOD_CATALOGUE.map((entry) => {
      const parsed = MethodSelection.safeParse(entry);
      return <tr key={entry.id}><td>{onChoose ? <button type="button" className={styles.action} disabled={!parsed.success || entry.releaseState === 'draft'} onClick={() => { if (parsed.success) onChoose(parsed.data); }}>{entry.displayName}</button> : entry.displayName}</td>
        <td>{entry.purpose}</td><td>{availability(entry.releaseState)}</td><td><Info label={`About ${entry.displayName}`} align="end"><MethodInformation entry={entry} /></Info></td></tr>;
    })}</tbody></table>;
}
export function MethodIdentifiers() {
  return <section id="identifiers"><h2>Method identifiers</h2><table className={styles.table}><thead><tr><th>Display name</th><th>Method identifier / Version</th><th>Availability</th></tr></thead>
    <tbody>{OPTIMIZATION_METHOD_CATALOGUE.map((entry) => <tr key={entry.id}><td>{entry.displayName}</td><td>{entry.id} · {entry.version}</td><td>{availability(entry.releaseState)}</td></tr>)}</tbody></table>
    <p className={styles.muted}>Reference describes Arcana's baseline derived from AdLabs. Candidate identifies a proposed method. Availability controls where a method can be used.</p></section>;
}
