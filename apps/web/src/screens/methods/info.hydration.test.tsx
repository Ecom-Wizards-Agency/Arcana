// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Info } from './info';

it('enables the information control only after its open handler attaches', async () => {
  const element = <Info label="Synthetic information">Recorded information</Info>;
  const host = document.createElement('div');
  document.body.append(host);
  host.innerHTML = renderToString(element);
  let root: Root | undefined;
  try {
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { root = hydrateRoot(host, element); });
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    expect(host.querySelector('[role="dialog"]')?.textContent).toBe('Recorded information');
  } finally {
    if (root) await act(async () => root?.unmount());
    host.remove();
  }
});
