'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProviderConnectionHealth, SpApiConnectionOperation, SpApiConsentRefusal, SpApiProfileBindingState } from '@wizard-ads/shared';
import type { SpApiConnectionSummary, SpApiSelectableProfile } from '../data/connections';
import { parseSpApiStartRefusal, spApiStartRefusalMessage } from '../screens/settings-connections/spapi-start-refusal';
import { TableFrame } from '../ui/primitives';
import { banner, input, muted, subheading, table, td, th } from '../ui/tokens';

const pending = new Set(['awaiting_consent', 'queued', 'exchanging']);
const labels: Record<SpApiConnectionOperation['state'], string> = {
  awaiting_consent: 'Waiting for seller authorization', queued: 'Seller authorization received', exchanging: 'Connecting seller account',
  completed: 'Seller account connected', reconnect_required: 'Seller account needs reconnecting', cancelled: 'Seller connection cancelled',
};
const reasons: Record<NonNullable<SpApiConnectionOperation['reason']>, string> = {
  not_configured: 'Seller connections are not configured. Contact your installation operator.',
  exchange_uncertain: 'The authorization could not be confirmed. Start a new connection.',
  exchange_refused: 'Amazon refused this authorization. Check application access and reconnect.',
  authority_changed: 'Membership or connection access changed. Start a new connection.',
  expired: 'The authorization expired. Start a new connection.', operator_cancelled: 'An agency manager cancelled this connection.',
};

const callbackMessages: Record<SpApiConsentRefusal, string> = {
  missing: 'Authorization state or browser cookie is missing. Start again.',
  mismatch: 'Authorization state does not match this request. Start again.',
  expired: 'The authorization expired. Start a new connection.',
  not_yet_valid: 'The authorization time is invalid. Start again.',
  reused: 'This authorization was already used for different consent. Start a new connection.',
  wrong_actor: 'This authorization belongs to a different signed-in user.',
  authority_changed: 'Account security or agency authority changed. Verify access and start again.',
  operation_not_pending: 'This connection is no longer accepting authorization. Check its saved status.',
  invalid_consent: 'The returned seller consent does not match the selected account. Start again.',
  not_configured: 'Seller connections are unavailable. Contact your installation operator.',
  submission_uncertain: 'Authorization receipt could not be confirmed. Check the saved connection status before starting again.',
  provider_refused: 'Seller authorization was declined. Start again when ready.',
};

const noBindings: SpApiProfileBindingState[] = [];
const enableReporting = 'Enable reporting for a profile below to receive the weekly search query performance report.';

/** The saved state in words. A missing start date is said, never replaced by a date. */
export function reportingStateLabel(binding: SpApiProfileBindingState): string {
  if (!binding.enabled) return 'Reporting disabled';
  // The database renders its session offset; the date shown is always UTC.
  return binding.enabledAt ? `Reporting enabled since ${new Date(binding.enabledAt).toISOString().slice(0, 10)}` : 'Reporting enabled (start date not recorded)';
}

/** `callbackError` carries a callback or a start refusal code; `startDetail` is the start refusal's fixed detail. */
export function SpApiConnections({ orgId, mayManage, enabled, connections, profiles, bindings = noBindings, initial, callbackError, startDetail = null }: {
  orgId: string; mayManage: boolean; enabled: boolean; connections: SpApiConnectionSummary[];
  profiles: SpApiSelectableProfile[]; bindings?: SpApiProfileBindingState[]; initial: SpApiConnectionOperation | null; callbackError: string | null;
  startDetail?: string | null;
}) {
  const router = useRouter();
  const [operation, setOperation] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<ProviderConnectionHealth | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [savedBindings, setSavedBindings] = useState<Record<string, SpApiProfileBindingState>>({});
  const [switching, setSwitching] = useState<string | null>(null);
  // A refreshed server list supersedes switches confirmed before it.
  useEffect(() => { setSavedBindings((current) => Object.keys(current).length ? {} : current); }, [bindings]);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const active = operation !== null && pending.has(operation.state);
  useEffect(() => { setOperation(initial); }, [initial]);
  const endpoint = operation ? `/api/amazon/spapi/operations/${operation.operationId}?${new URLSearchParams({ org: orgId })}` : null;
  useEffect(() => {
    if (!active || !endpoint || !operation) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const id = operation.operationId;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Unavailable');
        const body = await response.json() as { operation: unknown };
        const saved = SpApiConnectionOperation.parse(body.operation);
        if (saved.orgId !== orgId || saved.operationId !== id) throw new Error('Scope changed');
        if (controller.signal.aborted) return;
        setOperation(saved); setError(null);
        if (!pending.has(saved.state)) { router.refresh(); return; }
      } catch { if (controller.signal.aborted) return; setError('Seller connection status is unavailable. Refresh to check its saved state.'); }
      timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [active, endpoint, operation?.operationId, orgId, router]);

  async function command(id: string, kind: 'cancel' | 'health' | 'revoke'): Promise<void> {
    const signal = lifetime.current?.signal;
    setError(null);
    try {
      const path = kind === 'cancel' ? 'operations' : 'connections';
      const response = await fetch(`/api/amazon/spapi/${path}/${id}?${new URLSearchParams({ org: orgId })}`, {
        method: kind === 'health' ? 'GET' : 'POST', cache: 'no-store', signal,
      });
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json() as { operation?: unknown; health?: unknown };
      if (signal?.aborted) return;
      if (kind === 'cancel') {
        const saved = SpApiConnectionOperation.parse(body.operation);
        if (saved.orgId !== orgId || saved.operationId !== id) throw new Error('Scope changed');
        setOperation(saved);
      } else {
        const saved = ProviderConnectionHealth.parse(body.health);
        if (saved.connectionId !== id) throw new Error('Scope changed');
        setHealth(saved); setRevokeId(null);
      }
      router.refresh();
    } catch { if (!signal?.aborted) setError('The action could not be confirmed. Refresh to check the saved connection.'); }
  }

  async function switchReporting(binding: SpApiProfileBindingState, next: boolean): Promise<void> {
    const signal = lifetime.current?.signal;
    setError(null); setSwitching(binding.bindingId);
    try {
      const response = await fetch(`/api/amazon/spapi/connections/${binding.connectionId}/bindings/${binding.bindingId}?${new URLSearchParams({ org: orgId })}`, {
        method: 'POST', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
      });
      if (response.status === 409) throw new Error('Inactive');
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json() as { binding?: unknown };
      const saved = SpApiProfileBindingState.parse(body.binding);
      if (saved.bindingId !== binding.bindingId || saved.connectionId !== binding.connectionId || saved.enabled !== next) throw new Error('Scope changed');
      if (signal?.aborted) return;
      setSavedBindings((current) => ({ ...current, [saved.bindingId]: saved }));
      router.refresh();
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error && reason.message === 'Inactive' ? 'Reconnect the seller account before enabling reporting.'
        : 'The reporting change could not be confirmed. Refresh to check the saved state.');
    } finally { if (!signal?.aborted) setSwitching(null); }
  }

  const callbackRefusal = SpApiConsentRefusal.safeParse(callbackError);
  const startRefusal = callbackError && !callbackRefusal.success ? parseSpApiStartRefusal(callbackError, startDetail) : null;
  const linked = connections.find((connection) => connection.id === operation?.connectionId);
  const currentHealth = health?.connectionId === operation?.connectionId ? health : null;
  const connected = linked?.status === 'active' && linked.hasCredential
    && (!currentHealth || (currentHealth.state === 'active' && currentHealth.hasCredential));
  const completedLabel = currentHealth?.state === 'revoked' || linked?.status === 'revoked'
    ? 'Seller connection revoked' : 'Seller authorization completed previously';

  return <section data-testid="spapi-connections">
    <h2 style={subheading}>Seller Central</h2>
    <p style={muted}>Connect a seller account for the selected profiles. Reporting starts disabled. {enableReporting}</p>
    {callbackError && !startRefusal ? <p role="alert" style={banner('bad')}>{callbackRefusal.success ? callbackMessages[callbackRefusal.data] : 'Seller authorization could not be verified. Start again from Connections.'}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {operation ? <div aria-live="polite" style={banner(operation.state === 'completed' && connected ? 'good' : 'warn')} data-testid="spapi-progress">
      <strong>{operation.state === 'completed' && !connected ? completedLabel : labels[operation.state]}</strong>
      {operation.reason ? <p>{reasons[operation.reason]}</p> : null}
      <p>{operation.attachedBindings} of {operation.requestedBindings} selected profiles attached.</p>
      {operation.state === 'completed' ? <p>Reporting was left disabled when this connection completed. {enableReporting}</p> : null}
      {active && mayManage ? <button className="wa-btn wa-btn--sm" type="button" onClick={() => void command(operation.operationId, 'cancel')}>Cancel seller connection</button> : null}
    </div> : null}
    {connections.length ? <TableFrame><table style={table}>
      <thead><tr>{['Label','Status','Authorization','Profiles','Actions'].map((title) => <th key={title} style={th}>{title}</th>)}</tr></thead>
      <tbody>{connections.map((connection) => <tr key={connection.id} data-testid="spapi-connection-row">
      <td style={td}><strong>{connection.label}</strong></td><td style={td}>{connection.status}</td>
      <td style={td}>{connection.hasCredential ? 'Credential stored' : 'No active credential'}</td>
      <td style={td}>{connection.bindingCount} profile{connection.bindingCount === 1 ? '' : 's'} · {connection.enabledBindings} binding{connection.enabledBindings === 1 ? '' : 's'} enabled</td>
      <td style={td}><div className="wa-row" style={{ gap: '0.5rem',flexWrap: 'wrap' }}>
      <button className="wa-btn wa-btn--sm" type="button" onClick={() => void command(connection.id, 'health')}>Check seller connection</button>
      {mayManage ? <>
        <button className="wa-btn wa-btn--sm" type="button" disabled={!enabled || active} onClick={() => setLabel(connection.label)}>Reconnect seller account</button>
        {connection.status !== 'revoked' ? <button className="wa-btn wa-btn--sm" type="button" onClick={() => setRevokeId(connection.id)}>Revoke seller connection</button> : null}
        {revokeId === connection.id ? <span>Revoke access for {connection.label}? <button className="wa-btn wa-btn--sm" type="button" onClick={() => void command(connection.id, 'revoke')}>Yes, revoke seller connection</button> <button className="wa-btn wa-btn--sm" type="button" onClick={() => setRevokeId(null)}>Keep connection</button></span> : null}
      </> : null}
      </div></td>
    </tr>)}</tbody></table></TableFrame> : null}
    {bindings.length ? <TableFrame><table style={table} data-testid="spapi-bindings">
      <thead><tr>{['Seller connection','Profile','Marketplace','Weekly search query performance report','Actions'].map((title) => <th key={title} style={th}>{title}</th>)}</tr></thead>
      <tbody>{bindings.map((listed) => {
        const binding = savedBindings[listed.bindingId] ?? listed;
        const connection = connections.find((row) => row.id === binding.connectionId);
        const usable = connection?.status === 'active' && connection.hasCredential;
        return <tr key={binding.bindingId} data-testid="spapi-binding-row">
          <td style={td}>{connection?.label ?? 'Unknown connection'}</td>
          <td style={td}>{binding.profileName}</td>
          <td style={td}>{binding.marketplaceId}</td>
          <td style={td}><span data-testid="spapi-binding-reporting">{reportingStateLabel(binding)}</span>
            {binding.enabled && !binding.profileSyncEnabled ? <p style={muted}>Profile sync is off, so no weekly request is scheduled for this profile.</p> : null}
            {binding.enabled && !usable ? <p style={muted}>Reconnect the seller account; no weekly request is scheduled while it is inactive.</p> : null}</td>
          <td style={td}>{mayManage ? binding.enabled
            ? <button className="wa-btn wa-btn--sm" type="button" disabled={switching !== null} onClick={() => void switchReporting(binding, false)}>Disable reporting</button>
            : <button className="wa-btn wa-btn--sm" type="button" disabled={switching !== null || !usable} onClick={() => void switchReporting(binding, true)}>Enable reporting</button>
            : <span style={muted}>Owner or admin only</span>}</td>
        </tr>;
      })}</tbody></table></TableFrame> : null}
    {health ? <p role="status">Saved connection health: {health.state} · {health.hasCredential ? 'Credential stored' : 'No active credential'}</p> : null}
    {startRefusal ? <p role="alert" style={banner('bad')} data-testid="spapi-start-refusal">{spApiStartRefusalMessage(startRefusal)}</p> : null}
    {!mayManage ? <p style={muted}>Connecting Seller Central requires the admin or owner role.</p>
      : !enabled ? <p style={muted}>Seller connections are unavailable. Contact your installation operator.</p>
        : active ? <p style={muted}>Finish or cancel the current seller authorization before starting another.</p>
          : profiles.length === 0 ? <p>No supported seller profiles are available. Connect Amazon Ads and refresh its profile list first.</p>
            : <form method="post" action="/api/amazon/spapi/oauth/start" style={{ marginTop: '1rem' }}>
              <input type="hidden" name="org" value={orgId} />
              <label style={{ display: 'grid',gap: '0.5rem',maxWidth: '24rem' }}>Seller connection label <input style={{ ...input,width: '100%',boxSizing: 'border-box' }} name="label" value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={256} /></label>
              <p>When reconnecting, select every profile already attached to this connection.</p>
              <fieldset style={{ border: '1px solid var(--wa-color-border, #d1d5db)',borderRadius: '0.375rem',padding: '0.75rem',margin: '0 0 1rem' }}><legend>Profiles and marketplaces for this seller</legend>
                {profiles.filter((profile) => profile.connectionLabel === null || profile.connectionLabel === label).map((profile) => <label key={profile.id} style={{ display: 'block' }}>
                  <input type="checkbox" name="binding" value={`${profile.id}:${profile.marketplaceId}`} /> {profile.name} · {profile.countryCode} · {profile.marketplaceId}
                </label>)}
              </fieldset>
              <button className="wa-btn wa-btn--sm" type="submit" data-testid="connect-spapi">Connect Seller Central</button>
            </form>}
  </section>;
}
