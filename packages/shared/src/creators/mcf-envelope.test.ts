import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vector from './fixtures/rfc9180-a3-base.json' with { type: 'json' };
import {
  CREATOR_MCF_HPKE_INFO, CREATOR_MCF_HPKE_SUITE, CreatorMcfEnvelopeError, creatorMcfEnvelopeSha256, creatorMcfEnvelopeSupported,
  creatorMcfHpkeTestSeam as seam, creatorMcfRecipientKeyId, importCreatorMcfRecipientKey, openCreatorMcfRecipient,
  sealCreatorMcfRecipient,
} from './mcf-envelope.js';
import type { CreatorMcfEnvelopeErrorCode, CreatorMcfRecipientKey } from './mcf-envelope.js';
import {
  CREATOR_MCF_ENVELOPE_SUITE, CreatorMcfSealedRecipient, creatorMcfBase64UrlDecode, creatorMcfBase64UrlEncode, creatorMcfHex,
  creatorMcfMask, creatorMcfRecipientAad,
} from './mcf-send.js';
import type { CreatorMcfMask, CreatorMcfRecipient, CreatorMcfRecipientBinding } from './mcf-send.js';

const subtle = globalThis.crypto.subtle;
const hex = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** RFC 5915 ECPrivateKey inside RFC 5208 PKCS#8, for P-256 with the public key: the fixed DER frame around d and the point. */
const pkcs8 = (d: string, point: string): Uint8Array<ArrayBuffer> =>
  hex(`308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420${d}a144034200${point}`);
/**
 * An ephemeral pair from the private scalar alone: a PKCS#8 without the optional public key, so WebCrypto
 * computes pk(skE), and the public half is then taken from that computation, never from the RFC's pkEm.
 */
async function ephemeralFromScalar(d: string) {
  const der = hex(`3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420${d}`);
  const privateKey = await subtle.importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', privateKey);
  const publicKey = await subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { privateKey, publicKey };
}
const publicJwk = (point: string) => {
  const bytes = hex(point);
  return { kty: 'EC', crv: 'P-256', x: creatorMcfBase64UrlEncode(bytes.subarray(1, 33)), y: creatorMcfBase64UrlEncode(bytes.subarray(33, 65)) };
};

async function freshRecipientKeyPair() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pkcs8Bytes = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const { kty, crv, x, y } = await subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty, crv, x, y };
  return { pkcs8: pkcs8Bytes, jwk, keyId: await creatorMcfRecipientKeyId(jwk) };
}

// Synthetic, obviously fake values. Each is also a canary: none may appear in an envelope or an error.
const recipient: CreatorMcfRecipient = {
  name: 'Canary Recipient Zq', addressLine1: '100 Placeholder Way Zq', addressLine2: 'Unit Canary 7', city: 'Testville Zq',
  stateOrRegion: 'CA', postalCode: '90999', countryCode: 'US',
};
const binding: CreatorMcfRecipientBinding = {
  orgId: '33200000-0000-4000-8000-000000000001', creatorRecordId: 'CCR-TEST-26-0072', asin: 'B0TESTASIN',
  derivedOrderKey: `CCS-${'0123456789abcdef'.repeat(2)}`, reservationId: 'MCFR-9F2C41AB77E0D3B5',
};
const CANARIES = ['Canary Recipient Zq', '100 Placeholder Way Zq', 'Unit Canary 7', 'Testville Zq', '90999'];

async function expectFixedCode(work: Promise<unknown>, code: CreatorMcfEnvelopeErrorCode, forbidden: readonly string[] = []): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CreatorMcfEnvelopeError);
  const error = caught as CreatorMcfEnvelopeError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(error.cause).toBeUndefined();
  const surfaces = [error.message, String(error), error.stack ?? '', JSON.stringify(error)];
  for (const value of [...CANARIES, ...forbidden]) {
    for (const surface of surfaces) expect(surface.includes(value)).toBe(false);
  }
}

describe('RFC 9180 Appendix A.3.1: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, mode_base', () => {
  it('pins the suite the fixture describes', () => {
    expect(CREATOR_MCF_HPKE_SUITE).toEqual({ mode: vector.mode, kemId: vector.kemId, kdfId: vector.kdfId, aeadId: vector.aeadId });
    expect(vector.source).toBe('https://www.rfc-editor.org/rfc/rfc9180.txt');
  });

  it('reproduces enc, shared_secret, key_schedule_context, secret, key, base_nonce and the sequence-0 ciphertext byte for byte', async () => {
    const sender = await seam.setupBaseSender(hex(vector.pkRm), hex(vector.info), await ephemeralFromScalar(vector.skEm));
    // enc is serialized inside Encap from the public half WebCrypto computed from skEm; the RFC's pkEm is never an input.
    expect(creatorMcfHex(sender.enc)).toBe(vector.enc);
    expect(vector.enc).toBe(vector.pkEm);
    expect(creatorMcfHex(sender.sharedSecret)).toBe(vector.sharedSecret);
    expect(creatorMcfHex(sender.keyScheduleContext)).toBe(vector.keyScheduleContext);
    expect(creatorMcfHex(sender.secret)).toBe(vector.keyScheduleSecret);
    expect(creatorMcfHex(sender.key)).toBe(vector.key);
    expect(creatorMcfHex(sender.baseNonce)).toBe(vector.baseNonce);
    const first = vector.encryptions[0];
    expect(first?.sequenceNumber).toBe(0);
    const ct = await seam.aeadSeal(sender.key, seam.computeNonce(sender.baseNonce, 0), hex(first?.aad ?? ''), hex(first?.pt ?? ''));
    expect(creatorMcfHex(ct)).toBe(first?.ct);
  });

  it('opens the sequence-0 ciphertext with skRm imported through the production key import', async () => {
    const key = await importCreatorMcfRecipientKey(pkcs8(vector.skRm, vector.pkRm), publicJwk(vector.pkRm));
    const recipientSide = await seam.setupBaseRecipient(hex(vector.enc), key, hex(vector.info));
    expect(creatorMcfHex(recipientSide.sharedSecret)).toBe(vector.sharedSecret);
    expect(creatorMcfHex(recipientSide.key)).toBe(vector.key);
    expect(creatorMcfHex(recipientSide.baseNonce)).toBe(vector.baseNonce);
    const first = vector.encryptions[0];
    const pt = await seam.aeadOpen(recipientSide.key, seam.computeNonce(recipientSide.baseNonce, 0), hex(first?.aad ?? ''), hex(first?.ct ?? ''));
    expect(creatorMcfHex(pt)).toBe(first?.pt);
    expect(new TextDecoder().decode(pt)).toBe('Beauty is truth, truth beauty');
  });

  it('reproduces ComputeNonce and every listed encryption, not only sequence 0', async () => {
    const key = hex(vector.key);
    let checked = 0;
    for (const encryption of vector.encryptions) {
      const nonce = seam.computeNonce(hex(vector.baseNonce), encryption.sequenceNumber);
      expect(creatorMcfHex(nonce)).toBe(encryption.nonce);
      expect(creatorMcfHex(await seam.aeadSeal(key, nonce, hex(encryption.aad), hex(encryption.pt)))).toBe(encryption.ct);
      expect(creatorMcfHex(await seam.aeadOpen(key, nonce, hex(encryption.aad), hex(encryption.ct)))).toBe(encryption.pt);
      checked += 1;
    }
    expect(checked).toBe(6);
    expect(vector.encryptions.map((encryption) => encryption.sequenceNumber)).toEqual([0, 1, 2, 4, 255, 256]);
  });
});

describe('recipient keys', () => {
  it('names a key by the SHA-256 of its SPKI DER, identical to WebCrypto and node:crypto', async () => {
    const jwk = publicJwk(vector.pkRm);
    const imported = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const spki = new Uint8Array(await subtle.exportKey('spki', imported));
    expect(spki).toHaveLength(91);
    const expected = createHash('sha256').update(spki).digest('hex');
    expect(await creatorMcfRecipientKeyId(jwk)).toBe(expected);
    const key = await importCreatorMcfRecipientKey(pkcs8(vector.skRm, vector.pkRm), jwk);
    expect(key.keyId).toBe(expected);
    expect(Object.keys(key)).toEqual(['keyId']);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it('refuses a public key that is malformed, off the curve, or carries the private scalar, as key_mismatch', async () => {
    const jwk = publicJwk(vector.pkRm);
    await expectFixedCode(creatorMcfRecipientKeyId({ ...jwk, crv: 'P-384' }), 'key_mismatch');
    await expectFixedCode(creatorMcfRecipientKeyId({ ...jwk, y: jwk.x }), 'key_mismatch');
    const d = creatorMcfBase64UrlEncode(hex(vector.skRm));
    await expectFixedCode(creatorMcfRecipientKeyId({ ...jwk, d }), 'key_mismatch', [d]);
    await expectFixedCode(importCreatorMcfRecipientKey(pkcs8(vector.skRm, vector.pkRm), { ...jwk, d }), 'key_mismatch', [d, vector.skRm]);
  });

  it('refuses a private key whose public half is another key, garbage DER, and a handle it did not make', async () => {
    const other = await freshRecipientKeyPair();
    await expectFixedCode(importCreatorMcfRecipientKey(pkcs8(vector.skRm, vector.pkRm), other.jwk), 'key_mismatch', [vector.skRm]);
    await expectFixedCode(importCreatorMcfRecipientKey(utf8('not a key'), other.jwk), 'key_mismatch');
    const forged = Object.freeze({ keyId: other.keyId }) as unknown as CreatorMcfRecipientKey;
    const envelope = await sealCreatorMcfRecipient(other.jwk, other.keyId, binding, recipient);
    await expectFixedCode(openCreatorMcfRecipient(forged, envelope, binding), 'key_mismatch');
  });

  it('does not change the caller\'s PKCS#8 buffer', async () => {
    const pair = await freshRecipientKeyPair();
    const before = creatorMcfHex(pair.pkcs8);
    await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk);
    expect(creatorMcfHex(pair.pkcs8)).toBe(before);
  });
});

describe('seal and open', () => {
  it('round-trips a fresh envelope under Node WebCrypto and posts no plaintext', async () => {
    expect(creatorMcfEnvelopeSupported()).toBe(true);
    const pair = await freshRecipientKeyPair();
    const envelope = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    expect(CreatorMcfSealedRecipient.parse(envelope)).toEqual(envelope);
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'enc', 'envelopeId', 'keyId', 'mask', 'suite', 'v']);
    expect(envelope.suite).toBe(CREATOR_MCF_ENVELOPE_SUITE);
    expect(envelope.mask).toEqual({ countryCode: 'US', postalPrefix: '90', lines: 2 });
    const posted = JSON.stringify(envelope);
    for (const canary of CANARIES.slice(0, 4)) {
      expect(posted.includes(canary)).toBe(false);
      expect(posted.includes(creatorMcfBase64UrlEncode(utf8(canary)))).toBe(false);
    }
    const key = await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk);
    const opened = await openCreatorMcfRecipient(key, envelope, binding);
    expect(opened).toEqual({ status: 'opened', recipient, mask: envelope.mask });
  });

  it('uses a new ephemeral key and envelope id for every seal', async () => {
    const pair = await freshRecipientKeyPair();
    const first = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    const second = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    expect(first.enc).not.toBe(second.enc);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.envelopeId).not.toBe(second.envelopeId);
  });

  it('pins one Arcana envelope made with the RFC keys, so any change to the info, AAD or plaintext encoding shows', async () => {
    const jwk = publicJwk(vector.pkRm);
    const keyId = await creatorMcfRecipientKeyId(jwk);
    const envelope = await seam.sealWithEphemeral(jwk, keyId, binding, recipient, await ephemeralFromScalar(vector.skEm),
      '33200000-0000-4000-8000-0000000000e1');
    expect(envelope.enc).toBe(creatorMcfBase64UrlEncode(hex(vector.pkEm)));
    expect(keyId).toBe('a27764dca633730528009f8d8b027286ac7eb22a1fa52de0abe73eb7c7183360');
    expect(new TextDecoder().decode(creatorMcfRecipientAad({ ...binding, envelopeId: envelope.envelopeId, keyId, mask: envelope.mask })))
      .toBe('{"asin":"B0TESTASIN","creatorRecordId":"CCR-TEST-26-0072","derivedOrderKey":"CCS-0123456789abcdef0123456789abcdef",'
        + '"envelopeId":"33200000-0000-4000-8000-0000000000e1","keyId":"a27764dca633730528009f8d8b027286ac7eb22a1fa52de0abe73eb7c7183360",'
        + '"mask":{"countryCode":"US","lines":2,"postalPrefix":"90"},"orgId":"33200000-0000-4000-8000-000000000001",'
        + '"reservationId":"MCFR-9F2C41AB77E0D3B5","v":1}');
    expect(creatorMcfHex(creatorMcfBase64UrlDecode(envelope.ciphertext) ?? new Uint8Array(0))).toBe(PINNED_CIPHERTEXT_HEX);
    const key = await importCreatorMcfRecipientKey(pkcs8(vector.skRm, vector.pkRm), jwk);
    expect(await openCreatorMcfRecipient(key, envelope, binding)).toEqual({ status: 'opened', recipient, mask: envelope.mask });
    expect(CREATOR_MCF_HPKE_INFO).toBe('arcana.creator-mcf-recipient.v1');
  });

  it('digests the decoded ciphertext, the value the database stores as ciphertext_sha256', async () => {
    const pair = await freshRecipientKeyPair();
    const envelope = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    const bytes = creatorMcfBase64UrlDecode(envelope.ciphertext);
    expect(bytes).not.toBeNull();
    expect(await creatorMcfEnvelopeSha256(envelope)).toBe(createHash('sha256').update(bytes ?? new Uint8Array(0)).digest('hex'));
    await expectFixedCode(creatorMcfEnvelopeSha256({ ...envelope, extra: 1 }), 'envelope_invalid');
  });
});

describe('failures carry a fixed code and no input value', () => {
  const flip = (text: string, at: number, to: string): string => `${text.slice(0, at)}${to}${text.slice(at + 1)}`;

  it('fails envelope_unopenable when one character of any associated-data field changes', async () => {
    const pair = await freshRecipientKeyPair();
    const envelope = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    const key = await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk);
    const bindings: CreatorMcfRecipientBinding[] = [
      { ...binding, orgId: flip(binding.orgId, 0, '4') },
      { ...binding, creatorRecordId: 'CCR-TEST-26-0073' },
      { ...binding, asin: 'B0TESTASIM' },
      { ...binding, derivedOrderKey: flip(binding.derivedOrderKey, 4, '1') },
      { ...binding, reservationId: flip(binding.reservationId, 5, 'A') },
    ];
    const masks: CreatorMcfMask[] = [
      { ...envelope.mask, lines: 3 }, { ...envelope.mask, postalPrefix: '91' }, { ...envelope.mask, countryCode: 'CA' },
    ];
    const envelopes = [{ ...envelope, envelopeId: flip(envelope.envelopeId, 0, envelope.envelopeId.startsWith('a') ? 'b' : 'a') },
      ...masks.map((mask) => ({ ...envelope, mask }))];
    let refused = 0;
    for (const changed of bindings) {
      await expectFixedCode(openCreatorMcfRecipient(key, envelope, changed), 'envelope_unopenable', [changed.orgId]);
      refused += 1;
    }
    for (const changed of envelopes) {
      await expectFixedCode(openCreatorMcfRecipient(key, changed, binding), 'envelope_unopenable');
      refused += 1;
    }
    expect(refused).toBe(9);
    expect(await openCreatorMcfRecipient(key, envelope, binding)).toMatchObject({ status: 'opened' });
  });

  it('fails key_mismatch for a changed keyId, another recipient key, or a seal whose keyId is not the public key\'s', async () => {
    const pair = await freshRecipientKeyPair();
    const other = await freshRecipientKeyPair();
    const envelope = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    const key = await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk);
    const otherKey = await importCreatorMcfRecipientKey(other.pkcs8, other.jwk);
    await expectFixedCode(openCreatorMcfRecipient(key, { ...envelope, keyId: other.keyId }, binding), 'key_mismatch');
    await expectFixedCode(openCreatorMcfRecipient(otherKey, envelope, binding), 'key_mismatch');
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, other.keyId, binding, recipient), 'key_mismatch');
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, 'not-a-key-id', binding, recipient), 'key_mismatch');
  });

  it('fails on truncated, altered, undersized and oversized ciphertext and on a bad enc', async () => {
    const pair = await freshRecipientKeyPair();
    const envelope = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    const key = await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk);
    const bytes = creatorMcfBase64UrlDecode(envelope.ciphertext) ?? new Uint8Array(0);
    const encBytes = creatorMcfBase64UrlDecode(envelope.enc) ?? new Uint8Array(0);
    const altered = bytes.slice();
    altered[0] = (altered[0] ?? 0) ^ 1;
    const alteredEnc = encBytes.slice();
    alteredEnc[40] = (alteredEnc[40] ?? 0) ^ 1;
    const compressedEnc = encBytes.slice(0, 33);
    compressedEnc[0] = 0x02;
    const cases: [unknown, CreatorMcfEnvelopeErrorCode][] = [
      [{ ...envelope, ciphertext: creatorMcfBase64UrlEncode(bytes.subarray(0, bytes.length - 1)) }, 'envelope_unopenable'],
      [{ ...envelope, ciphertext: creatorMcfBase64UrlEncode(altered) }, 'envelope_unopenable'],
      [{ ...envelope, enc: creatorMcfBase64UrlEncode(alteredEnc) }, 'envelope_unopenable'],
      [{ ...envelope, ciphertext: creatorMcfBase64UrlEncode(bytes.subarray(0, 16)) }, 'envelope_invalid'],
      [{ ...envelope, ciphertext: creatorMcfBase64UrlEncode(new Uint8Array(4097)) }, 'envelope_invalid'],
      [{ ...envelope, enc: creatorMcfBase64UrlEncode(compressedEnc) }, 'envelope_invalid'],
      [{ ...envelope, ciphertext: `${envelope.ciphertext}=` }, 'envelope_invalid'],
      [{ ...envelope, v: 2 }, 'envelope_invalid'],
      [{ ...envelope, name: recipient.name }, 'envelope_invalid'],
    ];
    for (const [changed, code] of cases) await expectFixedCode(openCreatorMcfRecipient(key, changed, binding), code);
    expect(cases).toHaveLength(9);
    await expectFixedCode(openCreatorMcfRecipient(key, envelope, { ...binding, asin: 'not an asin' }), 'envelope_invalid', ['not an asin']);
    const smuggled: unknown = JSON.parse(JSON.stringify(envelope).replace(/^\{/, '{"__proto__":{"name":"Canary Recipient Zq"},'));
    await expectFixedCode(openCreatorMcfRecipient(key, smuggled, binding), 'envelope_invalid');
  });

  it('treats a throwing getter or Proxy as bad input, and a number as no key', async () => {
    const pair = await freshRecipientKeyPair();
    const envelope = await sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, recipient);
    const key = await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk);
    const trap = new Proxy({}, { get: () => { throw new Error('Canary Recipient Zq'); }, ownKeys: () => { throw new Error('Canary Recipient Zq'); } });
    const getter = Object.defineProperty({ ...recipient }, 'name', { enumerable: true, get: () => { throw new Error('Canary Recipient Zq'); } });
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, getter as CreatorMcfRecipient), 'envelope_invalid');
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, pair.keyId, trap as CreatorMcfRecipientBinding, recipient), 'envelope_invalid');
    await expectFixedCode(sealCreatorMcfRecipient(trap, pair.keyId, binding, recipient), 'key_mismatch');
    await expectFixedCode(openCreatorMcfRecipient(key, trap, binding), 'envelope_invalid');
    await expectFixedCode(openCreatorMcfRecipient(key, envelope, trap as CreatorMcfRecipientBinding), 'envelope_invalid');
    await expectFixedCode(importCreatorMcfRecipientKey(121 as unknown as Uint8Array, pair.jwk), 'key_mismatch');
  });

  it('refuses to seal an invalid recipient or binding as envelope_invalid, without echoing it', async () => {
    const pair = await freshRecipientKeyPair();
    const withPhone = { ...recipient, phone: '+1 555 0100 canary' } as unknown as CreatorMcfRecipient;
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, withPhone), 'envelope_invalid', ['555 0100 canary']);
    const { stateOrRegion: _state, ...noState } = recipient;
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, pair.keyId, binding, noState), 'envelope_invalid');
    await expectFixedCode(sealCreatorMcfRecipient(pair.jwk, pair.keyId, { ...binding, orgId: 'ORG-CANARY' }, recipient), 'envelope_invalid',
      ['ORG-CANARY']);
  });
});

describe('an authenticated envelope that Arcana still refuses', () => {
  async function sealRaw(plaintext: Uint8Array<ArrayBuffer>, mask: CreatorMcfMask) {
    const pair = await freshRecipientKeyPair();
    const { privateKey, publicKey } = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pkRm = new Uint8Array([0x04, ...(creatorMcfBase64UrlDecode(pair.jwk.x ?? '') ?? []), ...(creatorMcfBase64UrlDecode(pair.jwk.y ?? '') ?? [])]);
    const sender = await seam.setupBaseSender(pkRm, utf8(CREATOR_MCF_HPKE_INFO), { privateKey, publicKey });
    const envelopeId = '33200000-0000-4000-8000-0000000000e2';
    const aad = creatorMcfRecipientAad({ ...binding, envelopeId, keyId: pair.keyId, mask });
    const ct = await seam.aeadSeal(sender.key, seam.computeNonce(sender.baseNonce, 0), aad, plaintext);
    const envelope = { v: 1, suite: CREATOR_MCF_ENVELOPE_SUITE, envelopeId, keyId: pair.keyId,
      enc: creatorMcfBase64UrlEncode(sender.enc), ciphertext: creatorMcfBase64UrlEncode(ct), mask };
    return { envelope, key: await importCreatorMcfRecipientKey(pair.pkcs8, pair.jwk) };
  }
  const mask = creatorMcfMask(recipient);

  it('returns recipient_invalid with field and rule codes only', async () => {
    const { stateOrRegion: _state, ...noState } = recipient;
    const withPhone = { ...recipient, phone: '+1 555 0100 canary', 'Zq Canary Key': 'x' };
    const cases = [
      [noState, [{ field: 'stateOrRegion', rule: 'state_required' }]],
      [withPhone, [{ field: 'phone', rule: 'forbidden_field' }, { field: null, rule: 'unknown_field' }]],
    ] as const;
    for (const [plaintext, issues] of cases) {
      const { envelope, key } = await sealRaw(utf8(JSON.stringify(plaintext)), mask);
      const result = await openCreatorMcfRecipient(key, envelope, binding);
      expect(result).toEqual({ status: 'recipient_invalid', issues });
      expect(JSON.stringify(result).includes('canary')).toBe(false);
      expect(JSON.stringify(result).includes('Canary')).toBe(false);
    }
    const garbage = await sealRaw(utf8('not json Canary'), mask);
    expect(await openCreatorMcfRecipient(garbage.key, garbage.envelope, binding))
      .toEqual({ status: 'recipient_invalid', issues: [{ field: null, rule: 'malformed' }] });
    const invalidUtf8 = await sealRaw(new Uint8Array([0xff, 0xfe, 0x7b]), mask);
    expect(await openCreatorMcfRecipient(invalidUtf8.key, invalidUtf8.envelope, binding))
      .toEqual({ status: 'recipient_invalid', issues: [{ field: null, rule: 'malformed' }] });
  });

  it('returns mask_mismatch when the bound mask is not the plaintext\'s', async () => {
    const { envelope, key } = await sealRaw(utf8(JSON.stringify(recipient)), { ...mask, lines: 1 });
    expect(await openCreatorMcfRecipient(key, envelope, binding)).toEqual({ status: 'mask_mismatch' });
  });
});

describe('portability', () => {
  it('uses no Node-only API and logs nothing, so the browser runs the same code', () => {
    let scanned = 0;
    for (const file of ['./mcf-envelope.ts', './mcf-send.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const banned of [/from 'node:/, /(?<![A-Za-z])Buffer\b/, /\brequire\(/, /\bprocess\./, /\bconsole\./]) {
        expect(banned.test(source)).toBe(false);
      }
      scanned += 1;
    }
    expect(scanned).toBe(2);
  });
});

/**
 * Checked outside this repository against @hpke/core 1.9.0, an independent RFC 9180 implementation: it opens this
 * envelope with the hand-written AAD below and, sealing with the same ephemeral key, produces the same bytes.
 */
const PINNED_CIPHERTEXT_HEX = 'b81a950b65c17914bf015112c0e16ba9bf160de91ae0d51faf64faa1199f24d92f302c0c64f6684b268c6aba265b7dc8e3533adbf0871d9100df557dd0ca7d42'
  + '7a78770c966c42e927635003659b3c0a75b4c8255adfc62f65c12787e9b632beae49522ca5050a85dcfec08abd7b124144001a5afb754b765644aa83fa7904a1'
  + '53c2574207310f6a1fe779172cc11f57e44bf7138fac5223e27bf20c0fa5c996c9317f203d1d28dcc44585c57c65bc616d6e20ae810c25e19f7522ae9c0deef3'
  + '5301fddb6095e238';
