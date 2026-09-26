// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpApiConnections } from './spapi-connections';
import type { SpApiConnectionOperation } from '@wizard-ads/shared';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const orgId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const operation: SpApiConnectionOperation = { operationId: id,orgId,connectionId: null,state: 'awaiting_consent',reason: null,
  requestedBindings: 2,attachedBindings: 0,createdAt: '2026-01-01T00:00:00Z',updatedAt: '2026-01-01T00:00:00Z' };
const base = { orgId,mayManage: true,enabled: true,connections: [],profiles: [{ id,name: 'Synthetic seller',marketplaceId: 'ATVPDKIKX0DER',countryCode: 'US',connectionLabel: null }],initial: null,callbackError: null };
afterEach(() => { vi.restoreAllMocks(); });
describe('seller connection controls', () => {
  it('shows exact profile selection only to an enabled manager', () => {
    render(<SpApiConnections {...base} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('checkbox').getAttribute('value')).toBe(id + ':ATVPDKIKX0DER');
    expect(screen.getByRole('button',{ name: 'Connect Seller Central' })).toBeDefined();
  });
  it.each(['viewer','analyst'] as const)('shows metadata without mutation controls to %s', () => {
    render(<SpApiConnections {...base} mayManage={false} connections={[{ id,label: 'Synthetic seller',status: 'active',hasCredential: true,bindingCount: 2,enabledBindings: 0 }]} />);
    expect(screen.getByText('2 profiles · 0 bindings enabled')).toBeDefined();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button',{ name: 'Revoke seller connection' })).toBeNull();
    expect(screen.getByRole('button',{ name: 'Check seller connection' })).toBeDefined();
  });
  it('explains the disabled gate and unsupported profile state', () => {
    const view = render(<SpApiConnections {...base} enabled={false} />);
    expect(screen.getByText(/Seller connections are unavailable/)).toBeDefined();
    view.rerender(<SpApiConnections {...base} profiles={[]} />);
    expect(screen.getByText(/No supported seller profiles/)).toBeDefined();
  });
  it.each(['awaiting_consent','queued','exchanging','completed','reconnect_required','cancelled'] as const)('renders saved operation state %s and counted bindings', (state) => {
    vi.spyOn(globalThis,'fetch').mockImplementation(() => new Promise(() => {}));
    render(<SpApiConnections {...base} initial={{ ...operation,state,attachedBindings: state === 'completed' ? 2 : 0,
      reason: state === 'reconnect_required' ? 'exchange_uncertain' : null }} />);
    expect(screen.getByTestId('spapi-progress').textContent).toContain(`${state === 'completed' ? 2 : 0} of 2`);
    expect(screen.queryAllByRole('button',{ name: 'Cancel seller connection' })).toHaveLength(['awaiting_consent','queued','exchanging'].includes(state) ? 1 : 0);
    if (state === 'completed') expect(screen.getByText(/Reporting was left disabled/)).toBeDefined();
  });
  it('reconciles a completed banner with the current revoked connection', () => {
    const completed = { ...operation, state: 'completed' as const, connectionId: id, attachedBindings: 2 };
    const connection = { id, label: 'Synthetic seller', status: 'active' as const, hasCredential: true, bindingCount: 2, enabledBindings: 0 };
    const view = render(<SpApiConnections {...base} initial={completed} connections={[connection]} />);
    expect(screen.getByText('Seller account connected')).toBeDefined();
    view.rerender(<SpApiConnections {...base} initial={completed} connections={[{ ...connection, status: 'revoked', hasCredential: false }]} />);
    expect(screen.queryByText('Seller account connected')).toBeNull();
    expect(screen.getByText('Seller connection revoked')).toBeDefined();
    expect(screen.getByTestId('spapi-progress').style.background).toContain('warn');
  });
  it('shows sanitized callback reasons without echoing arbitrary query text', () => {
    const view = render(<SpApiConnections {...base} callbackError="reused" />);
    expect(screen.getByRole('alert').textContent).toContain('already used');
    view.rerender(<SpApiConnections {...base} callbackError="synthetic-untrusted-provider-text" />);
    expect(screen.getByRole('alert').textContent).not.toContain('synthetic-untrusted-provider-text');
  });
  it.each([
    ['configuration', 'SP_API_OAUTH_REGION', 'Seller connections are not fully configured: SP_API_OAUTH_REGION is missing or invalid.'],
    ['database', 'association_refused', 'The database refused this connection: SP-API profile association refused.'],
    ['selection', 'bindings', 'Select between 1 and 50 seller profiles'],
    ['session', null, 'Sign in again to continue.'],
  ] as const)('shows the %s start refusal next to the form', (refusal, detail, text) => {
    render(<SpApiConnections {...base} callbackError={refusal} startDetail={detail} />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const alert = screen.getByTestId('spapi-start-refusal');
    expect(alert.textContent).toContain(text);
    expect(alert.nextElementSibling?.tagName).toBe('FORM');
  });
  it('refuses start details outside the fixed codes', () => {
    const view = render(<SpApiConnections {...base} callbackError="configuration" startDetail="synthetic-untrusted-setting" />);
    expect(screen.queryByTestId('spapi-start-refusal')).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toContain('synthetic-untrusted-setting');
    view.rerender(<SpApiConnections {...base} callbackError="role" startDetail="synthetic-untrusted-detail" />);
    expect(screen.queryByTestId('spapi-start-refusal')).toBeNull();
    view.rerender(<SpApiConnections {...base} mayManage={false} callbackError="role" />);
    expect(screen.getByTestId('spapi-start-refusal').textContent).toContain('cannot manage seller connections');
  });
  it('requires explicit revocation confirmation and shows the saved revoked state', async () => {
    const fetch = vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ health: { connectionId: id,state: 'revoked',hasCredential: false } }));
    render(<SpApiConnections {...base} initial={{ ...operation, state: 'completed', connectionId: id, attachedBindings: 2 }} enabled={false} connections={[{ id,label: 'Synthetic seller',status: 'active',hasCredential: true,bindingCount: 2,enabledBindings: 0 }]} />);
    fireEvent.click(screen.getByRole('button',{ name: 'Revoke seller connection' })); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{ name: 'Yes, revoke seller connection' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('revoked'));
    expect(screen.queryByText('Seller account connected')).toBeNull();
    expect(screen.getByText('Seller connection revoked')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });
  describe('per-binding reporting control', () => {
    const connectionId = '33333333-3333-4333-8333-333333333333';
    const bindingId = '44444444-4444-4444-8444-444444444444';
    const connection = { id: connectionId,label: 'Synthetic seller',status: 'active' as const,hasCredential: true,bindingCount: 2,enabledBindings: 1 };
    const disabled = { bindingId,connectionId,profileId: id,profileName: 'Synthetic profile',marketplaceId: 'ATVPDKIKX0DER',
      enabled: false,enabledAt: null,profileSyncEnabled: true };
    const enabled = { ...disabled,bindingId: '55555555-5555-4555-8555-555555555555',profileName: 'Synthetic second profile',
      enabled: true,enabledAt: '2026-09-21T08:30:00.000000+00:00' };
    it('points the connection copy to the control', () => {
      render(<SpApiConnections {...base} initial={{ ...operation,state: 'completed',connectionId,attachedBindings: 2 }} connections={[connection]} bindings={[disabled]} />);
      const pointer = 'Enable reporting for a profile below to receive the weekly search query performance report.';
      expect(screen.getAllByText((_, element) => element?.tagName === 'P' && element.textContent?.includes(pointer) === true)).toHaveLength(2);
      expect(screen.queryByText(/until it is separately enabled/)).toBeNull();
    });
    it('renders both saved states with one control each for a manager', () => {
      render(<SpApiConnections {...base} connections={[connection]} bindings={[disabled,enabled]} />);
      const rows = screen.getAllByTestId('spapi-binding-row');
      expect(rows).toHaveLength(2);
      expect(screen.getAllByTestId('spapi-binding-reporting').map((cell) => cell.textContent)).toEqual(['Reporting disabled','Reporting enabled since 2026-09-21']);
      expect(rows[0]!.textContent).toContain('Synthetic profile'); expect(rows[0]!.textContent).toContain('ATVPDKIKX0DER');
      expect(screen.getAllByRole('button',{ name: 'Enable reporting' })).toHaveLength(1);
      expect(screen.getAllByRole('button',{ name: 'Disable reporting' })).toHaveLength(1);
    });
    it('never invents a start date and says why an enabled profile is not scheduled', () => {
      render(<SpApiConnections {...base} connections={[{ ...connection,status: 'revoked',hasCredential: false }]}
        bindings={[{ ...enabled,enabledAt: null,profileSyncEnabled: false },disabled]} />);
      expect(screen.getAllByTestId('spapi-binding-reporting')[0]!.textContent).toBe('Reporting enabled (start date not recorded)');
      expect(screen.getByText(/Profile sync is off/)).toBeDefined();
      expect(screen.getByText(/while it is inactive/)).toBeDefined();
      expect((screen.getByRole('button',{ name: 'Enable reporting' }) as HTMLButtonElement).disabled).toBe(true);
    });
    it.each(['viewer','analyst'] as const)('shows the saved state without a control to %s', () => {
      render(<SpApiConnections {...base} mayManage={false} connections={[connection]} bindings={[disabled,enabled]} />);
      expect(screen.getAllByTestId('spapi-binding-row')).toHaveLength(2);
      expect(screen.queryAllByRole('button',{ name: /able reporting/ })).toHaveLength(0);
      expect(screen.getAllByText('Owner or admin only')).toHaveLength(2);
    });
    it('posts the exact switch and shows the saved result', async () => {
      const saved = { ...disabled,enabled: true,enabledAt: '2026-09-26T10:00:00.000000+00:00' };
      const fetch = vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ binding: saved }));
      render(<SpApiConnections {...base} connections={[connection]} bindings={[disabled]} />);
      fireEvent.click(screen.getByRole('button',{ name: 'Enable reporting' }));
      await waitFor(() => expect(screen.getByTestId('spapi-binding-reporting').textContent).toBe('Reporting enabled since 2026-09-26'));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]![0])).toBe(`/api/amazon/spapi/connections/${connectionId}/bindings/${bindingId}?org=${orgId}`);
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST',body: JSON.stringify({ enabled: true }) });
      expect(screen.getByRole('button',{ name: 'Disable reporting' })).toBeDefined();
    });
    it('keeps the saved state when the switch is refused or answers for another binding', async () => {
      const fetch = vi.spyOn(globalThis,'fetch')
        .mockResolvedValueOnce(Response.json({ error: 'Reconnect' },{ status: 409 }))
        .mockResolvedValueOnce(Response.json({ binding: { ...enabled,bindingId: '66666666-6666-4666-8666-666666666666' } }));
      render(<SpApiConnections {...base} connections={[connection]} bindings={[disabled]} />);
      fireEvent.click(screen.getByRole('button',{ name: 'Enable reporting' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Reconnect the seller account'));
      fireEvent.click(screen.getByRole('button',{ name: 'Enable reporting' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be confirmed'));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('spapi-binding-reporting').textContent).toBe('Reporting disabled');
    });
  });
});
