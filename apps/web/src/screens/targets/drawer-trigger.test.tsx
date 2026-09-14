// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TargetDrawerProvider, TargetDrawerTrigger } from './drawer-trigger';

it('opens the named drawer outside the row, shows loading, and closes without row navigation', () => {
  const navigate = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  try {
    const { container } = render(<TargetDrawerProvider profileId="11111111-1111-4111-8111-111111111111" window={{start:'2026-09-01',end:'2026-09-02'}} currencyCode="USD"><div onClick={navigate}><TargetDrawerTrigger label="synthetic target" targetId="synthetic-target" /></div></TargetDrawerProvider>);
    const trigger = screen.getByRole('button', {name:'Open Target 360 for synthetic target'});
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('status').textContent).toContain('Loading bid history');
    expect(container.contains(screen.getByRole('dialog'))).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toContain('/api/targets/synthetic-target?');
    fireEvent.click(screen.getByRole('button', {name:'Close bid history'}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(navigate).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('keeps the open drawer mounted after its virtualized trigger leaves the row tree', () => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {})));
  const props = { profileId:'11111111-1111-4111-8111-111111111111', window:{start:'2026-09-01',end:'2026-09-02'}, currencyCode:'USD' };
  try {
    const { rerender } = render(<TargetDrawerProvider {...props}><TargetDrawerTrigger label="synthetic target" targetId="synthetic-target" /></TargetDrawerProvider>);
    fireEvent.click(screen.getByRole('button', {name:'Open Target 360 for synthetic target'}));
    const dialog = screen.getByRole('dialog');
    rerender(<TargetDrawerProvider {...props}>{null}</TargetDrawerProvider>);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('status').textContent).toContain('Loading bid history');
    fireEvent.keyDown(window, {key:'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
