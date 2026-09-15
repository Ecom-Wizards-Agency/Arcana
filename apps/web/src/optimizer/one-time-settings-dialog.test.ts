// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OneTimeSettingsDialog } from '../../app/optimizer/one-time-settings-dialog';

it('submits the explicit reference method identity from the unchanged settings form', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalMethods = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
  for (const [name] of originalMethods) Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: vi.fn() });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onConfirm = vi.fn();
  try {
    act(() => root.render(createElement(OneTimeSettingsDialog, {
      campaignCount: 1, settings: [{ targetAcos: 0.37, bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41 }],
      period: { start: '2026-08-01', end: '2026-08-26' }, profileToday: '2026-08-27', timezone: 'UTC', currencyCode: 'USD',
      submitting: false, onClose: () => {}, onConfirm,
    })));
    act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ method: 'sp.reference-efficiency', targetAcos: 0.37 });
    expect(host.textContent).toContain('Assigned group values override the run fields');
    const method = host.querySelector<HTMLSelectElement>('select[name="method"]')!;
    act(() => { method.value = 'sp.coordinated-efficiency'; method.dispatchEvent(new Event('change', { bubbles: true })); });
    const exposure = host.querySelector<HTMLInputElement>('input[name="exposureCeiling"]')!;
    const clicks = host.querySelector<HTMLInputElement>('input[name="minClicksPerPlacement"]')!;
    exposure.value = '1.73'; clicks.value = '19';
    act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm.mock.calls[1]?.[0]).toMatchObject({ version: 2, method: 'sp.coordinated-efficiency',
      exposureCeiling: 1.73, minClicksPerPlacement: 19, placementEvidenceRequirements: 'single_target', targetAcos: 0.37 });
    expect(host.textContent).toContain('Draft previews cannot be approved');
  } finally {
    act(() => root.unmount());
    host.remove();
    for (const [name, original] of originalMethods) {
      if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
      else Object.defineProperty(HTMLDialogElement.prototype, name, original);
    }
  }
});
