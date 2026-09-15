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
const base = { orgId,mayManage: true,enabled: true,connections: [],profiles: [{ id,name: 'Synthetic seller',marketplaceId: 'ATVPDKIKX0DER',countryCode: 'US',connectionLabel: null }],initial: null,callbackError: false };
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
  it('requires explicit revocation confirmation and shows the saved revoked state', async () => {
    const fetch = vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ health: { connectionId: id,state: 'revoked',hasCredential: false } }));
    render(<SpApiConnections {...base} enabled={false} connections={[{ id,label: 'Synthetic seller',status: 'active',hasCredential: true,bindingCount: 2,enabledBindings: 0 }]} />);
    fireEvent.click(screen.getByRole('button',{ name: 'Revoke seller connection' })); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{ name: 'Yes, revoke seller connection' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('revoked'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });
});
