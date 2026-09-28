// @vitest-environment jsdom
/**
 * The address form in a live React tree (WP-338g): inputs without names, the
 * review panel beside the tracker row, the browser seal to a key generated at
 * run time, the form cleared before the post, and a post that carries only
 * {binding, envelope} with no trace of what was typed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreatorMcfSealRequest, creatorMcfRecipientKeyId } from '@wizard-ads/shared';
import '../render-test-support';
import { GATE_ON, PREVIEW, SEND, withSend } from './render-fixture';
import { forgetSealedInTab, type SendActions } from './send';
import type { SendActionResult } from './send-actions';
import type { SendData } from './send-model';
import Screen from './view';

/** Synthetic canaries, one per field; none may leave the browser in any encoding. */
const CANARY = {
  name: 'Zq Canaryname Xv', addressLine1: '1 Canaryline Street', addressLine2: 'Unit Canarytwo', city: 'Canarycity', stateOrRegion: 'CA', postalCode: '94999-0001',
};

async function publicKey(): Promise<Extract<SendData['key'], { status: 'ok' }>> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: exported.x!, y: exported.y! };
  return { status: 'ok', keyId: await creatorMcfRecipientKeyId(jwk), jwk };
}

function fakeActions(seal: (body: unknown) => Promise<SendActionResult>): SendActions {
  const refused = async (): Promise<SendActionResult> => ({ ok: false, reason: 'unavailable' });
  return { seal, approve: refused, withdraw: refused, refresh: refused, settleRead: refused, release: refused, resolveConflict: refused };
}

const input = (field: string) => document.querySelector<HTMLInputElement>(`[data-recipient-field="${field}"]`)!;
const type = (field: keyof typeof CANARY) => fireEvent.change(input(field), { target: { value: CANARY[field] } });

afterEach(() => { cleanup(); forgetSealedInTab(); });

describe('address entry', () => {
  it('renders inputs with no name and autocomplete off, in no form, with no reveal control', async () => {
    const key = await publicKey();
    render(<Screen data={withSend(null, { data: { key, gate: { ...GATE_ON, keyIds: [key.keyId] } } })} actions={fakeActions(vi.fn())} />);
    await screen.findByTestId('address-form');
    const fields = [...document.querySelectorAll('[data-testid="address-form"] input, [data-testid="address-form"] select')];
    expect(fields).toHaveLength(9);
    for (const field of fields) {
      expect(field.hasAttribute('name')).toBe(false);
      expect(field.getAttribute('autocomplete')).toBe('off');
      expect(field.closest('form')).toBeNull();
    }
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/show recipient|reveal/i);
    expect([...document.querySelectorAll('[data-recipient-field="countryCode"] option')].map((option) => option.textContent)).toEqual(['US']);
  });

  it('refuses an incomplete address with field words and never posts', async () => {
    const key = await publicKey();
    const seal = vi.fn<(body: unknown) => Promise<SendActionResult>>();
    render(<Screen data={withSend(null, { data: { key, gate: { ...GATE_ON, keyIds: [key.keyId] } } })} actions={fakeActions(seal)} />);
    await screen.findByTestId('address-form');
    type('name');
    fireEvent.click(screen.getByTestId('review-address'));
    const issues = screen.getAllByTestId('recipient-issue').map((item) => item.textContent);
    expect(issues).toEqual(['Address line 1 is required', 'Postal code is required']);
    expect(screen.queryByTestId('address-review')).toBeNull();
    expect(seal).not.toHaveBeenCalled();
  });

  it('reviews the block beside the tracker row, seals it, clears the form and posts only the envelope', async () => {
    const key = await publicKey();
    const posted: unknown[] = [];
    const seal = vi.fn(async (body: unknown): Promise<SendActionResult> => {
      posted.push(body);
      // The form is already empty when the post leaves.
      expect(document.querySelectorAll('[data-recipient-field]')).toHaveLength(0);
      return { ok: true, sendId: SEND.sendId, state: 'sealed', custodyExpiresAt: '2026-09-09T08:40:00.000Z' };
    });
    const data = withSend(null, { data: { key, gate: { ...GATE_ON, keyIds: [key.keyId] } } });
    const writes = vi.fn();
    const store = { setItem: writes, getItem: () => null, removeItem: writes, clear: writes, key: () => null, length: 0 };
    Object.defineProperty(window, 'localStorage', { value: store, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: store, configurable: true });
    const history = vi.spyOn(window.history, 'pushState');
    const replaced = vi.spyOn(window.history, 'replaceState');
    const view = render(<Screen data={data} actions={fakeActions(seal)} />);
    await screen.findByTestId('address-form');
    for (const field of Object.keys(CANARY) as (keyof typeof CANARY)[]) type(field);
    fireEvent.click(screen.getByTestId('review-address'));
    const review = await screen.findByTestId('address-review');
    expect(screen.getByTestId('review-record').textContent).toBe('CCR-SW-26-0088');
    expect(screen.getByTestId('review-source').textContent).toContain('ASIN B0D9K3M2QP');
    expect(screen.getByTestId('review-block').textContent).toBe(
      'Zq Canaryname Xv\n1 Canaryline Street\nUnit Canarytwo\nCanarycity, CA 94999-0001\nUS');
    expect([...review.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Seal address', 'Edit']);
    await act(async () => { fireEvent.click(screen.getByTestId('seal-address')); });
    await waitFor(() => expect(seal).toHaveBeenCalledTimes(1));

    expect(posted).toHaveLength(1);
    const body = posted[0] as Record<string, Record<string, unknown>>;
    expect(Object.keys(body).sort()).toEqual(['binding', 'envelope']);
    expect(Object.keys(body['envelope']!).sort()).toEqual(['ciphertext', 'enc', 'envelopeId', 'keyId', 'mask', 'suite', 'v']);
    expect(body['binding']).toEqual({ orgId: data.props.send.orgId, creatorRecordId: 'CCR-SW-26-0088', asin: 'B0D9K3M2QP',
      derivedOrderKey: data.props.detail.lane.derivedOrderKey, reservationId: data.props.detail.lane.reservationId });
    expect(body['envelope']!['mask']).toEqual({ countryCode: 'US', postalPrefix: '94', lines: 2 });
    expect(body['envelope']!['keyId']).toBe(key.keyId);
    expect(CreatorMcfSealRequest.safeParse(body).success).toBe(true);
    const wire = JSON.stringify(body);
    for (const value of Object.values(CANARY).filter((text) => text.length > 3)) {
      for (const form of [value, value.toLowerCase(), encodeURIComponent(value), btoa(value)]) expect(wire).not.toContain(form);
    }
    expect(wire).not.toContain('Canary');

    // The page refreshes into the sealed send; this tab alone remembers initials and the full postal code.
    view.rerender(<Screen data={withSend({ state: 'sealed', latestPreview: null }, { data: { key, gate: { ...GATE_ON, keyIds: [key.keyId] } } })}
      actions={fakeActions(seal)} />);
    expect(screen.getByTestId('sealed-mask').textContent).toBe('Address sealed · US · 94••• · 2 lines · expires 08:35 UTC');
    expect(screen.getByTestId('sealed-memory').textContent).toBe('In this tab only: Z. C. X. · 94999-0001. Never stored or sent.');
    expect(screen.getByTestId('type-again').textContent).toBe('Type the address again');
    expect(document.body.textContent).not.toContain('Canaryline');
    expect(writes).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(replaced).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('renders nothing typed while the envelope is in flight', async () => {
    const key = await publicKey();
    let finish: (result: SendActionResult) => void = () => undefined;
    const seal = vi.fn(() => new Promise<SendActionResult>((resolve) => { finish = resolve; }));
    render(<Screen data={withSend(null, { data: { key, gate: { ...GATE_ON, keyIds: [key.keyId] } } })} actions={fakeActions(seal)} />);
    await screen.findByTestId('address-form');
    for (const field of Object.keys(CANARY) as (keyof typeof CANARY)[]) type(field);
    fireEvent.click(screen.getByTestId('review-address'));
    await act(async () => { fireEvent.click(await screen.findByTestId('seal-address')); });
    await waitFor(() => expect(seal).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('seal-posting').textContent).toContain('the form is cleared');
    expect(screen.queryByTestId('address-review')).toBeNull();
    expect(document.querySelectorAll('[data-recipient-field]')).toHaveLength(0);
    for (const value of Object.values(CANARY).filter((text) => text.length > 3)) expect(document.body.textContent).not.toContain(value);
    await act(async () => { finish({ ok: true, sendId: SEND.sendId, state: 'sealed' }); });
    expect(screen.getByTestId('type-again')).toBeTruthy();
  });

  it('says why a refused seal stored nothing, and keeps the plaintext out of the page', async () => {
    const key = await publicKey();
    const seal = vi.fn(async (): Promise<SendActionResult> => ({ ok: false, reason: 'binding_mismatch' }));
    render(<Screen data={withSend(null, { data: { key, gate: { ...GATE_ON, keyIds: [key.keyId] } } })} actions={fakeActions(seal)} />);
    await screen.findByTestId('address-form');
    for (const field of Object.keys(CANARY) as (keyof typeof CANARY)[]) type(field);
    fireEvent.click(screen.getByTestId('review-address'));
    await act(async () => { fireEvent.click(await screen.findByTestId('seal-address')); });
    const refusal = await screen.findByTestId('seal-refused');
    expect(refusal.textContent).toContain('The lane changed since this page was read.');
    expect(refusal.textContent).toContain('Nothing was stored; type the address again.');
    expect(input('name').value).toBe('');
    expect(input('postalCode').value).toBe('');
  });
});

describe('the press', () => {
  it('replays one request id for one preview and mints a new one for a fresh preview after a stale one', async () => {
    const approvals: { requestId: string; previewId: string; confirmation: string }[] = [];
    const approve = vi.fn(async (approval: unknown): Promise<SendActionResult> => {
      approvals.push(approval as { requestId: string; previewId: string; confirmation: string });
      return { ok: false, reason: 'unavailable' };
    });
    const actions = { ...fakeActions(vi.fn()), approve };
    const view = render(<Screen data={withSend({})} actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByTestId('send-button')); });
    await act(async () => { fireEvent.click(screen.getByTestId('send-button')); });
    const fresh = { ...PREVIEW, previewId: '33800000-0000-4000-8000-0000000000a2' };
    view.rerender(<Screen data={withSend({ latestPreview: { ...SEND.latestPreview!, previewId: fresh.previewId, preview: fresh } })} actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByTestId('send-button')); });
    expect(approvals).toHaveLength(3);
    expect(document.querySelectorAll('[data-testid="send-card"]')).toHaveLength(1);
    expect(approvals.map((approval) => approval.confirmation)).toEqual(Array(3).fill('Send 1 unit via Amazon'));
    expect(approvals[0]!.requestId).toBe(approvals[1]!.requestId);
    expect(approvals[2]!.requestId).not.toBe(approvals[0]!.requestId);
    expect(approvals.map((approval) => approval.previewId)).toEqual([PREVIEW.previewId, PREVIEW.previewId, fresh.previewId]);
  });
});
