'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AmazonConnectionOperation } from '@wizard-ads/shared';
import { banner, muted } from '../ui/tokens';

const activeStates = new Set(['awaiting_consent', 'queued', 'exchanging', 'discovering']);
const labels: Record<AmazonConnectionOperation['state'], string> = {
  awaiting_consent: 'Waiting for Amazon authorization', queued: 'Authorization received · waiting for worker',
  exchanging: 'Connecting to Amazon', discovering: 'Discovering available profiles', completed: 'Connected',
  partial: 'Connected with incomplete discovery', empty: 'No advertising profiles found',
  reconnect_required: 'Connect again', refused: 'Connection authorization changed', cancelled: 'Connection cancelled',
};
const reasons: Record<NonNullable<AmazonConnectionOperation['reason']>, string> = {
  consent_expired: 'The authorization link expired. Start a new connection.',
  code_expired: 'The worker did not claim the authorization in time. Ask your installation operator to check the worker, then connect again.',
  exchange_refused: 'Amazon refused this authorization. Check access to the Amazon application and connect again.',
  exchange_uncertain: 'The authorization exchange could not be confirmed. A new Amazon authorization is required.',
  authority_changed: 'Membership or connection authority changed. An agency owner or admin can start a new connection.',
  installation_changed: 'The Amazon application configuration changed. Ask your installation operator to check the callback configuration, then connect again.',
  discovery_failed: 'No regional discovery completed. Check Amazon application access and worker availability, then connect again.',
  discovery_incomplete: 'Some regions or profiles could not be loaded. The counts below show what was saved; reconnect to retry discovery.',
  no_profiles: 'Amazon returned no advertising profiles in any region. Check the Amazon account used for authorization.',
  operator_cancelled: 'An agency manager cancelled this operation. You can start a new connection.',
};

export function ConnectionProgress({ initial, mayCancel }: { initial: AmazonConnectionOperation; mayCancel: boolean }) {
  const router = useRouter();
  const [operation, setOperation] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [checkedAt, setCheckedAt] = useState(Date.now());
  const active = activeStates.has(operation.state);
  const endpoint = `/api/amazon/connections/${operation.operationId}?${new URLSearchParams({ org: operation.orgId })}`;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Status unavailable');
        const body = await response.json() as { operation?: unknown };
        const saved = AmazonConnectionOperation.parse(body.operation);
        if (saved.orgId !== initial.orgId || saved.operationId !== initial.operationId) throw new Error('Connection scope changed');
        if (controller.signal.aborted) return;
        setOperation(saved); setError(null); setCheckedAt(Date.now());
        if (!activeStates.has(saved.state)) { router.refresh(); return; }
      } catch {
        if (controller.signal.aborted) return;
        setError('Status is temporarily unavailable. Your saved operation will be checked again.');
      }
      timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [active, endpoint, initial.orgId, initial.operationId, router]);

  async function cancel(): Promise<void> {
    setCancelling(true); setError(null);
    try {
      const response = await fetch(endpoint, { method: 'POST', cache: 'no-store' });
      if (!response.ok) throw new Error('Cancellation unavailable');
      const body = await response.json() as { operation?: unknown };
      const saved = AmazonConnectionOperation.parse(body.operation);
      if (saved.orgId !== operation.orgId || saved.operationId !== operation.operationId) throw new Error('Connection scope changed');
      setOperation(saved); router.refresh();
    } catch { setError('Cancellation could not be confirmed. Refresh to check the saved state before trying again.'); }
    finally { setCancelling(false); }
  }

  const stalled = active && checkedAt - Date.parse(operation.updatedAt) > 60_000;
  const total = operation.regions.reduce((count, region) => count + region.upserted, 0);
  const failed = operation.regions.filter((region) => region.state === 'failed');
  const severity = operation.state === 'completed' ? 'good' : active || ['partial','empty','cancelled'].includes(operation.state) ? 'warn' : 'bad';
  return <section style={banner(severity)} aria-live="polite" data-testid="oauth-result">
    <strong>{labels[operation.state]}</strong>
    {operation.reason ? <p>{reasons[operation.reason]}</p> : null}
    {stalled ? <p>The worker has not reported recent progress. Check worker availability; cancel this operation before starting another authorization.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {operation.connectionId ? <>
      <p><span data-testid="oauth-total">{total}</span> profile(s) saved.</p>
      <ul>{operation.regions.map((region) => <li key={region.region} data-testid={`oauth-region-${region.region}`}>
        {region.region}: {region.upserted} · {region.state}
        {region.received !== null ? ` · received ${region.received}, parsed ${region.parsed}, refused ${region.rejected}, new ${region.created}` : ''}
      </li>)}</ul>
      {failed.length > 0 ? <p data-testid="oauth-failed">Discovery unavailable in: {failed.map((region) => region.region).join(', ')}</p> : null}
      {total > 0 ? <a href={`/settings/profiles?${new URLSearchParams({ org: operation.orgId })}`}>Choose profiles to synchronize</a> : null}
    </> : null}
    {active && mayCancel ? <p><button type="button" className="wa-btn wa-btn--sm" disabled={cancelling} onClick={() => void cancel()}>
      {cancelling ? 'Checking cancellation…' : 'Cancel connection'}
    </button></p> : null}
    {operation.state === 'awaiting_consent' ? <p style={muted}>Finish the open Amazon authorization, or cancel and start again.</p> : null}
  </section>;
}
