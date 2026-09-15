'use client';

import { useState, type ReactNode } from 'react';
import { DataGrid, toneStyle } from '@wizard-ads/ui';
import type { Tone } from '@wizard-ads/ui';
import styles from './creative.module.css';

export { integer, percent, money, ratio, dateLabel, creativeHref, creativeCampaignHref } from "./format";

/** Broken or expired presigned URLs remain a labelled tile, never a broken image. */
export function CreativeThumbnail({ url, name, large = false }: { url: string | null; name: string; large?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const className = `${styles.thumbnail} ${large ? styles.thumbnailLarge : ''}`;
  const expired = url !== null && thumbnailExpired(url);
  if (url === null || failedUrl === url || expired) return <span role="img" aria-label={`${name}: ${url === null ? 'Thumbnail not available' : 'Thumbnail expired or unavailable'}`} className={`${className} ${styles.fallback}`}>{url === null ? 'No thumbnail' : large ? 'Thumbnail unavailable' : 'Unavailable'}</span>;
  // Amazon supplies short-lived URLs; next/image would cache these beyond their expiry.
  return <img src={url} alt={name} className={className} onError={() => setFailedUrl(url)} ref={(node) => { if (node?.complete && node.naturalWidth === 0) setFailedUrl(url); }} referrerPolicy="no-referrer" />;
}

function thumbnailExpired(value: string): boolean {
  try {
    const params = new URL(value).searchParams;
    const expires = params.get('Expires');
    if (expires !== null && /^\d+$/.test(expires)) return Number(expires) * 1000 <= Date.now();
    const signed = params.get('X-Amz-Date'), lifetime = params.get('X-Amz-Expires');
    if (signed !== null && lifetime !== null && /^\d{8}T\d{6}Z$/.test(signed) && /^\d+$/.test(lifetime)) {
      const timestamp = `${signed.slice(0, 4)}-${signed.slice(4, 6)}-${signed.slice(6, 8)}T${signed.slice(9, 11)}:${signed.slice(11, 13)}:${signed.slice(13, 15)}Z`;
      return Date.parse(timestamp) + Number(lifetime) * 1000 <= Date.now();
    }
  } catch { return true; }
  return false;
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  const colors = toneStyle[tone];
  return <span style={{ background: colors.background, color: colors.color, border: `1px solid ${colors.border}`, borderRadius: 'var(--wa-radius-sm)', padding: '2px 6px', whiteSpace: 'nowrap', fontSize: 'var(--wa-fs-2xs)' }}>{children}</span>;
}

export function EvidenceCard({ title, children, tone = 'info' }: { title: string; children: ReactNode; tone?: 'info' | 'warn' | 'missing' }) {
  return <section className={`${styles.card} ${styles[tone]}`}><h3>{title}</h3>{children}</section>;
}

export function Missing({ reason }: { reason: string }) { return <DataGrid.cells.NotMeasuredCell reason={reason} />; }

export function Measure({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return <div className={styles.metric}><dt>{label}</dt><dd>{value}</dd><small>{children}</small></div>;
}

export function DataTable({ label, headers, children, totals }: { label: string; headers: readonly string[]; children: ReactNode; totals?: ReactNode }) {
  return <div className={styles.tableWrap} role="region" aria-label={label} tabIndex={0}><table className={styles.table}><thead><tr>{headers.map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead><tbody>{children}</tbody>{totals === undefined ? null : <tfoot>{totals}</tfoot>}</table></div>;
}
