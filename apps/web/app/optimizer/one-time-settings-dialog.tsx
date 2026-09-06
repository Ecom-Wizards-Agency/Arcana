'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ONE_TIME_RPC_BID_FIELDS, OneTimeRpcConfiguration, type OneTimeRpcBidSettings } from '@wizard-ads/shared';
import { commonOneTimeSettings, completedPreviewWindow } from '../../src/optimizer/one-time-settings';

const fields: Array<{ name: typeof ONE_TIME_RPC_BID_FIELDS[number]; label: string; percentage: boolean }> = [
  { name: 'targetAcos', label: 'Target ACOS (%)', percentage: true },
  { name: 'bidFloor', label: 'Minimum bid', percentage: false },
  { name: 'bidCeiling', label: 'Maximum bid', percentage: false },
  { name: 'bidIncreaseCap', label: 'Maximum bid increase (%)', percentage: true },
  { name: 'bidDecreaseCap', label: 'Maximum bid decrease (%)', percentage: true },
];

export function OneTimeSettingsDialog({ campaignCount, settings, period, profileToday, timezone, currencyCode, submitting, submissionError, onClose, onConfirm }: {
  campaignCount: number;
  settings: readonly (Partial<OneTimeRpcBidSettings> | null | undefined)[];
  period: { start: string; end: string };
  profileToday: string;
  timezone: string;
  currencyCode: string;
  submitting: boolean;
  submissionError?: string | null;
  onClose(): void;
  onConfirm(configuration: OneTimeRpcConfiguration): void;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const common = commonOneTimeSettings(settings);
  const window = completedPreviewWindow(period, profileToday);
  const missing = ONE_TIME_RPC_BID_FIELDS.some((field) => common[field] === undefined);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);

  return <dialog ref={dialog} aria-labelledby="one-time-preview-title" className="wa-card" style={{ width: 'min(34rem, calc(100vw - 2rem))', padding: '1.25rem', border: '1px solid var(--wa-border)', borderRadius: '0.75rem' }}
    onCancel={(event) => { event.preventDefault(); if (!submitting) onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const numbers = Object.fromEntries(fields.map((field) => {
        const raw = String(data.get(field.name) ?? '').trim();
        return [field.name, raw === '' ? undefined : Number(raw) / (field.percentage ? 100 : 1)];
      }));
      const result = OneTimeRpcConfiguration.safeParse({ ...numbers, version: 1, method: 'rpc', window: { start: data.get('start'), end: data.get('end') } });
      if (!result.success) { setError(result.error.issues[0]?.message ?? 'Review the preview settings.'); return; }
      if (result.data.window.end >= profileToday) { setError('Choose completed days before today in this account’s timezone.'); return; }
      setError(null);
      onConfirm(result.data);
    }}>
      <h2 id="one-time-preview-title" className="wa-card__title">Confirm one-time preview</h2>
      <p>{campaignCount.toLocaleString('en-US')} campaigns · RPC · {currencyCode}</p>
      <p className="wa-hint">Uses revenue per click with the existing bid rules and stock, rank, and observation safeguards. Saved strategies and schedules stay unchanged.</p>
      {missing ? <p className="wa-hint">Some settings are mixed or missing. Choose a value for each blank field.</p> : <p className="wa-hint">Matching settings from the selected campaigns are prefilled.</p>}
      <fieldset disabled={submitting} style={{ border: 0, padding: 0, display: 'grid', gap: '0.75rem', gridTemplateColumns: '1fr 1fr' }}>
        {fields.map((field) => <label className="wa-label" key={field.name}>
          {field.label}{field.percentage ? '' : ` (${currencyCode})`}
          <input className="wa-input" name={field.name} type="number" required step="any" min="0"
            max={field.name === 'bidDecreaseCap' ? '100' : undefined}
            defaultValue={common[field.name] === undefined ? '' : Number((common[field.name]! * (field.percentage ? 100 : 1)).toPrecision(12))} />
        </label>)}
        <label className="wa-label">Reporting start<input className="wa-input" name="start" type="date" required max={window.lastComplete} defaultValue={window.start} /></label>
        <label className="wa-label">Reporting end<input className="wa-input" name="end" type="date" required max={window.lastComplete} defaultValue={window.end} /></label>
      </fieldset>
      <p className="wa-hint">Completed reporting days · {timezone}. These dates are fixed for this run.</p>
      {error === null && !submissionError ? null : <p role="alert">{error ?? submissionError}</p>}
      <div className="wa-row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
        <button className="wa-btn wa-btn--ghost" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
        <button className="wa-btn wa-btn--primary" type="submit" disabled={submitting}>{submitting ? 'Queueing preview…' : 'Run read-only preview'}</button>
      </div>
    </form>
  </dialog>;
}
