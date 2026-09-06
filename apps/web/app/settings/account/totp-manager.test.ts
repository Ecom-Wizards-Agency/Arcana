// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TotpFactorId, TotpOverview } from '../../../src/auth/totp';

const actions = vi.hoisted(() => ({
  cancelTotpSetup: vi.fn(), confirmTotpEnrollment: vi.fn(),
  removeTotp: vi.fn(), startTotpEnrollment: vi.fn(),
}));
vi.mock('./totp-actions', () => actions);

import { TotpManager } from './totp-manager';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const overview: TotpOverview = {
  status: 'ok',
  factors: ids.map((id, i) => ({ id: id as TotpFactorId, label: `Device ${i + 1}`, createdAt: '2026-01-01' })),
};

describe('account authenticator controls', () => {
  const host = document.createElement('div');
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows removal with enrollment disabled and captures exact factors only after confirmation', async () => {
    act(() => root.render(createElement(TotpManager, { overview, next: '/settings/account', allowEnrollment: false })));
    const buttons = () => Array.from(host.querySelectorAll('button'));
    expect(buttons().some((button) => button.textContent === 'Add authenticator')).toBe(false);
    const disable = buttons().find((button) => button.textContent === 'Turn off authenticator 2FA');
    expect(disable).toBeDefined();
    expect(host.querySelector('form')).toBeNull();
    act(() => disable?.click());
    expect(actions.removeTotp).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Remove all 2 authenticators');
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    expect(new FormData(form!).getAll('factorId')).toEqual(ids);
    actions.removeTotp.mockResolvedValue({ status: 'error', message: 'Removed 1 of 2 selected authenticators. 1 remain; authenticator 2FA is still on.' });
    await act(async () => { form!.requestSubmit(); });
    expect(actions.removeTotp).toHaveBeenCalledTimes(1);
    expect((actions.removeTotp.mock.calls[0]![1] as FormData).getAll('factorId')).toEqual(ids);
    expect(host.textContent).toContain('Removed 1 of 2 selected authenticators');
    expect(host.textContent).not.toContain('Authenticator 2FA is off.');
  });

  it('cancels without changing account security', () => {
    act(() => root.render(createElement(TotpManager, { overview, next: '/settings/account', allowEnrollment: false })));
    act(() => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Turn off authenticator 2FA')?.click());
    act(() => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')?.click());
    expect(host.querySelector('form')).toBeNull();
    expect(actions.removeTotp).not.toHaveBeenCalled();
  });
});
