'use client';
import { useState } from 'react';
import type { OptimizationGroupPerformance, OptimizationGroupPerformanceMetrics } from '@wizard-ads/shared';
import styles from '../methods/styles.module.css';
const METRICS = ['spend', 'sales', 'acos', 'orders'] as const;
const label = (metric: string) => metric === 'acos' ? 'ACOS' : metric[0]!.toUpperCase() + metric.slice(1);
function format(value: number | null, metric: keyof OptimizationGroupPerformanceMetrics, currency: string) {
  if (value === null) return 'Unavailable';
  return metric === 'acos' ? `${(value * 100).toFixed(2)}%` : metric === 'orders' ? value.toLocaleString('en') : new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
}
export function GroupPerformance({ performance, currency, profileId }: { performance: OptimizationGroupPerformance; currency: string; profileId: string }) {
  const [metric, setMetric] = useState<keyof OptimizationGroupPerformanceMetrics>('acos');
  const [compare, setCompare] = useState(true);
  const values = performance.days.map((day) => day[metric]);
  const max = Math.max(0, ...values.filter((value): value is number => value !== null));
  const points = values.map((value, index) => value === null ? null : `${values.length === 1 ? 50 : index * 100 / (values.length - 1)},${max === 0 ? 90 : 90 - value / max * 80}`).filter((point): point is string => point !== null).join(' ');
  return <><form className={styles.actions} method="get"><input type="hidden" name="profile" value={profileId} />
    <label className={styles.field}>From<input type="date" name="from" defaultValue={performance.current.start} /></label><label className={styles.field}>To<input type="date" name="to" defaultValue={performance.current.end} /></label><button className={styles.action}>Show period</button>
    <label><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /> Compare previous period</label></form>
    <strong>History for the group's current {performance.campaignIds.length} campaigns</strong><p className={styles.muted}>Campaigns added or removed from the group change which history is included.</p>
    <section className={styles.panel}><h2>Performance over time</h2><div className={styles.actions}>{METRICS.map((name) => <button type="button" key={name} className={`${styles.action} ${name === metric ? styles.primary : ''}`} aria-pressed={name === metric} onClick={() => setMetric(name)}>{label(name)}</button>)}</div>
      <div className={styles.chart}>{performance.reportingRows === 0 || points.length === 0 ? <p>No reporting data for this period</p> : <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 180 }} role="img" aria-label={`${label(metric)} history for ${performance.days.length} reporting days`}><polyline points={points} fill="none" stroke="var(--wa-accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" /></svg>}</div>
      <span className={styles.muted}>{performance.current.start} to {performance.current.end}{compare ? ` · Comparison: ${performance.previous.start} to ${performance.previous.end}` : ''} · Current {performance.campaignIds.length} members</span>
    </section>
    {performance.reportingRows === 0 ? <aside className={styles.panel}><strong>Performance history unavailable</strong><p>Spend, sales, ACOS and order history will appear when reporting data is available for these campaigns.</p></aside> : null}
    <table className={styles.table}><thead><tr><th>Metric</th><th>Selected period</th>{compare ? <><th>Previous period</th><th>Change</th></> : null}</tr></thead><tbody>{METRICS.map((key) => {
      const current = performance.current.metrics[key], previous = performance.previous.metrics[key];
      return <tr key={key}><td>{label(key)}</td><td>{format(current, key, currency)}</td>{compare ? <><td>{format(previous, key, currency)}</td><td>{current === null || previous === null || previous === 0 ? 'Unavailable' : `${(((current - previous) / previous) * 100).toFixed(1)}%`}</td></> : null}</tr>;
    })}</tbody></table>
  </>;
}
