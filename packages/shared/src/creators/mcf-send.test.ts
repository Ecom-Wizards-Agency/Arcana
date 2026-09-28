import { describe, expect, it } from 'vitest';
import { FulfillmentOrderStatus } from '../spapi-fulfillment.js';
import {
  CREATOR_MCF_IRREVERSIBILITY, CREATOR_MCF_MAX_UNITS, CREATOR_MCF_PACKING_SLIP_COMMENT, CREATOR_MCF_RECIPIENT_FIELDS,
  CREATOR_MCF_SEND_INITIAL_STATE, CREATOR_MCF_SEND_TRANSITIONS, CreatorMcfCancelPreview, CreatorMcfEscalation, CreatorMcfMask,
  CreatorMcfPreview, CreatorMcfProviderOutcome, CreatorMcfRecipient, CreatorMcfRecipientBinding, CreatorMcfRecipientPublicJwk,
  CreatorMcfReservationId, CreatorMcfSealRequest, CreatorMcfSealedRecipient,
  CreatorMcfSendApproval, CreatorMcfSendCounts, CreatorMcfSendOutcome, CreatorMcfSendOutcomeClass, CreatorMcfSendPreview,
  CreatorMcfSendState, assertCreatorMcfCounts, canTransitionCreatorMcfSend, classifyMcfOrderStatus, creatorMcfBase64UrlDecode,
  creatorMcfBase64UrlEncode, creatorMcfCancelConfirmation, creatorMcfCanonicalJson, creatorMcfMask, creatorMcfPreviewFingerprint,
  creatorMcfPreviewsDiffer, creatorMcfRecipientAad, creatorMcfRecipientIssues, creatorMcfSendConfirmation, creatorMcfSendOutcomeClass,
  isCustodyHeldState, isTerminalState,
} from './mcf-send.js';
import type { CreatorMcfSendState as SendState, CreatorMcfSendPreview as SendPreview } from './mcf-send.js';
import { CreatorReservationId } from './runner.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const orderKey = `CCS-${'0123456789abcdef'.repeat(2)}`;

// Synthetic, obviously fake recipient. The words double as canaries.
const recipient = {
  name: 'Canary Recipient Zq', addressLine1: '100 Placeholder Way Zq', city: 'Testville Zq', stateOrRegion: 'CA',
  postalCode: '90999', countryCode: 'US',
};

describe('CreatorMcfRecipient (acceptance 5)', () => {
  it('accepts a US address with a state, trims every value, and a JP address without a city', () => {
    expect(CreatorMcfRecipient.parse({ ...recipient, name: '  Canary Recipient Zq  ' }).name).toBe('Canary Recipient Zq');
    const { city: _city, stateOrRegion: _state, ...rest } = recipient;
    expect(CreatorMcfRecipient.safeParse({ ...rest, countryCode: 'JP', postalCode: '100-0001' }).success).toBe(true);
    expect(CreatorMcfRecipient.safeParse({ ...rest, city: 'Testville Zq', countryCode: 'CA', postalCode: 'K1A 0B1' }).success).toBe(true);
  });

  it('refuses unknown keys, email and phone, naming only fixed field names', () => {
    const cases: [Record<string, unknown>, unknown[]][] = [
      [{ ...recipient, email: 'canary@example.invalid' }, [{ field: 'email', rule: 'forbidden_field' }]],
      [{ ...recipient, phone: '+1 555 0100' }, [{ field: 'phone', rule: 'forbidden_field' }]],
      [{ ...recipient, phoneNumber: '+1 555 0100', notificationEmails: ['canary@example.invalid'] },
        [{ field: 'phone', rule: 'forbidden_field' }, { field: 'email', rule: 'forbidden_field' }]],
      [{ ...recipient, 'Canary Zq Key': 'x' }, [{ field: null, rule: 'unknown_field' }]],
    ];
    for (const [input, issues] of cases) {
      expect(CreatorMcfRecipient.safeParse(input).success).toBe(false);
      const found = creatorMcfRecipientIssues(input);
      expect(found).toEqual(issues);
      expect(JSON.stringify(found)).not.toMatch(/canary|Canary|555/);
    }
    expect(cases).toHaveLength(4);
  });

  it('requires city unless JP, and stateOrRegion for US only', () => {
    const { city: _city, ...noCity } = recipient;
    const { stateOrRegion: _state, ...noState } = recipient;
    expect(creatorMcfRecipientIssues(noCity)).toEqual([{ field: 'city', rule: 'city_required' }]);
    expect(creatorMcfRecipientIssues({ ...noCity, countryCode: 'DE' })).toEqual([{ field: 'city', rule: 'city_required' }]);
    expect(creatorMcfRecipientIssues({ ...noCity, countryCode: 'JP' })).toEqual([]);
    expect(creatorMcfRecipientIssues(noState)).toEqual([{ field: 'stateOrRegion', rule: 'state_required' }]);
    expect(creatorMcfRecipientIssues({ ...noState, countryCode: 'CA' })).toEqual([]);
  });

  it('holds Arcana\'s length limits: 60 per text field, 20 for the postal code', () => {
    expect(CreatorMcfRecipient.safeParse({ ...recipient, name: 'n'.repeat(60) }).success).toBe(true);
    expect(creatorMcfRecipientIssues({ ...recipient, name: 'n'.repeat(61) })).toEqual([{ field: 'name', rule: 'too_long' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, addressLine3: 'l'.repeat(61) })).toEqual([{ field: 'addressLine3', rule: 'too_long' }]);
    expect(CreatorMcfRecipient.safeParse({ ...recipient, postalCode: '9'.repeat(20) }).success).toBe(true);
    expect(creatorMcfRecipientIssues({ ...recipient, postalCode: '9'.repeat(21) })).toEqual([{ field: 'postalCode', rule: 'too_long' }]);
  });

  it('names missing, blank, malformed and mistyped values by rule, never by value', () => {
    const { name: _name, ...noName } = recipient;
    expect(creatorMcfRecipientIssues(noName)).toEqual([{ field: 'name', rule: 'required' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, name: '   ' })).toEqual([{ field: 'name', rule: 'required' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, postalCode: '' })).toEqual([{ field: 'postalCode', rule: 'required' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, postalCode: '9' })).toEqual([{ field: 'postalCode', rule: 'too_short' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, postalCode: '90999#' })).toEqual([{ field: 'postalCode', rule: 'invalid_format' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, countryCode: 'us' })).toEqual([{ field: 'countryCode', rule: 'invalid_format' }]);
    expect(creatorMcfRecipientIssues({ ...recipient, name: 42 })).toEqual([{ field: 'name', rule: 'invalid_type' }]);
    expect(creatorMcfRecipientIssues('Canary Recipient Zq')).toEqual([{ field: null, rule: 'malformed' }]);
    expect(creatorMcfRecipientIssues(null)).toEqual([{ field: null, rule: 'malformed' }]);
    const trap = new Proxy({}, { get: () => { throw new Error('Canary Zq'); }, ownKeys: () => { throw new Error('Canary Zq'); } });
    expect(creatorMcfRecipientIssues(trap)).toEqual([{ field: null, rule: 'malformed' }]);
  });

  it('refuses control, invisible format (bidi, zero-width), line-separator and unpaired-surrogate characters in every field', () => {
    const bad = ['Canary\nZq', 'Canary\u0000Zq', 'Canary\u2028Zq', 'Canary\ud800Zq', 'Canary\u202eZq', 'Canary\u200bZq', 'Canary\ufeffZq',
      'Canary\u00adZq', 'Canary\u2066Zq'];
    const textFields = ['name', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'districtOrCounty', 'stateOrRegion'] as const;
    let refused = 0;
    for (const field of textFields) {
      for (const value of bad) {
        expect(creatorMcfRecipientIssues({ ...recipient, [field]: value })).toEqual([{ field, rule: 'invalid_format' }]);
        refused += 1;
      }
    }
    expect(refused).toBe(textFields.length * bad.length);
    expect(creatorMcfRecipientIssues({ ...recipient, postalCode: '90\u200b999' })).toEqual([{ field: 'postalCode', rule: 'invalid_format' }]);
    expect(CreatorMcfRecipient.safeParse({ ...recipient, name: 'Zoë Ångström 😀' }).success).toBe(true);
  });

  it('refuses an own "__proto__" key instead of dropping it', () => {
    const smuggled: unknown = JSON.parse(`{"__proto__":{"phone":"+1 555 0100"},${JSON.stringify(recipient).slice(1)}`);
    expect(Object.hasOwn(smuggled as object, '__proto__')).toBe(true);
    expect(CreatorMcfRecipient.safeParse(smuggled).success).toBe(false);
    expect(creatorMcfRecipientIssues(smuggled)).toEqual([{ field: null, rule: 'unknown_field' }]);
  });

  it('lists exactly the nine v2020 Address fields it accepts', () => {
    expect([...CREATOR_MCF_RECIPIENT_FIELDS].sort()).toEqual(Object.keys(CreatorMcfRecipient.out.shape).sort());
    expect(CREATOR_MCF_RECIPIENT_FIELDS).toHaveLength(9);
  });
});

describe('the mask and the associated data', () => {
  it('shows country, two upper-cased postal characters and the line count only', () => {
    const parsed = CreatorMcfRecipient.parse({ ...recipient, countryCode: 'CA', postalCode: 'k1a 0b1', addressLine2: 'Unit 7' });
    expect(creatorMcfMask(parsed)).toEqual({ countryCode: 'CA', postalPrefix: 'K1', lines: 2 });
    expect(creatorMcfMask(CreatorMcfRecipient.parse({ ...recipient, addressLine2: 'a', addressLine3: 'b' })).lines).toBe(3);
    expect(CreatorMcfMask.safeParse({ countryCode: 'US', postalPrefix: '90', lines: 2, name: 'x' }).success).toBe(false);
  });

  it('serializes the associated data canonically, whatever the key order', () => {
    const fields = {
      orgId: '33200000-0000-4000-8000-000000000001', creatorRecordId: 'CCR-TEST-26-0072', asin: 'B0TESTASIN', derivedOrderKey: orderKey,
      reservationId: 'MCFR-9F2C41AB77E0D3B5', envelopeId: '33200000-0000-4000-8000-0000000000e1', keyId: 'b'.repeat(64),
      mask: { lines: 1, postalPrefix: '90', countryCode: 'US' },
    };
    const reversed = Object.fromEntries(Object.entries(fields).reverse()) as typeof fields;
    const text = new TextDecoder().decode(creatorMcfRecipientAad(fields));
    expect(text).toBe(new TextDecoder().decode(creatorMcfRecipientAad(reversed)));
    expect(text).toBe(`{"asin":"B0TESTASIN","creatorRecordId":"CCR-TEST-26-0072","derivedOrderKey":"${orderKey}",`
      + `"envelopeId":"33200000-0000-4000-8000-0000000000e1","keyId":"${'b'.repeat(64)}",`
      + '"mask":{"countryCode":"US","lines":1,"postalPrefix":"90"},"orgId":"33200000-0000-4000-8000-000000000001",'
      + '"reservationId":"MCFR-9F2C41AB77E0D3B5","v":1}');
    expect(() => creatorMcfRecipientAad({ ...fields, orgId: '33200000-0000-4000-8000-00000000000A' })).toThrow();
    expect(() => creatorMcfRecipientAad({ ...fields, extra: 1 } as typeof fields)).toThrow();
  });
});

describe('the sealed envelope schema', () => {
  const envelope = {
    v: 1, suite: 'DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM', envelopeId: '33200000-0000-4000-8000-0000000000e1',
    keyId: 'b'.repeat(64), enc: creatorMcfBase64UrlEncode(Uint8Array.of(4, ...new Uint8Array(64).fill(7))),
    ciphertext: creatorMcfBase64UrlEncode(new Uint8Array(17)), mask: { countryCode: 'US', postalPrefix: '90', lines: 1 },
  };

  it('accepts the envelope keys and nothing that could carry plaintext', () => {
    expect(CreatorMcfSealedRecipient.safeParse(envelope).success).toBe(true);
    let refused = 0;
    for (const field of [...CREATOR_MCF_RECIPIENT_FIELDS, 'recipient', 'plaintext', 'address', 'phone', 'email']) {
      expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, [field]: 'x' }).success).toBe(false);
      refused += 1;
    }
    expect(refused).toBe(14);
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, mask: { ...envelope.mask, name: 'x' } }).success).toBe(false);
  });

  it('bounds enc to an uncompressed point and the ciphertext to 17..4,096 bytes', () => {
    const encoded = (length: number) => creatorMcfBase64UrlEncode(new Uint8Array(length));
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, ciphertext: encoded(4096) }).success).toBe(true);
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, ciphertext: encoded(4097) }).success).toBe(false);
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, ciphertext: encoded(16) }).success).toBe(false);
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, enc: creatorMcfBase64UrlEncode(Uint8Array.of(2, ...new Uint8Array(64))) }).success).toBe(false);
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, enc: creatorMcfBase64UrlEncode(Uint8Array.of(4, ...new Uint8Array(32))) }).success).toBe(false);
    expect(CreatorMcfSealedRecipient.safeParse({ ...envelope, envelopeId: envelope.envelopeId.toUpperCase() }).success).toBe(false);
  });

  it('accepts a public JWK and refuses one carrying the private scalar', () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: creatorMcfBase64UrlEncode(new Uint8Array(32)), y: creatorMcfBase64UrlEncode(new Uint8Array(32)) };
    expect(CreatorMcfRecipientPublicJwk.safeParse({ ...jwk, ext: true, key_ops: [] }).success).toBe(true);
    expect(CreatorMcfRecipientPublicJwk.safeParse({ ...jwk, d: jwk.x }).success).toBe(false);
    expect(CreatorMcfRecipientPublicJwk.safeParse({ ...jwk, crv: 'P-384' }).success).toBe(false);
  });
});

describe('the seal request and the lane binding', () => {
  const binding = {
    orgId: '33200000-0000-4000-8000-000000000001', creatorRecordId: 'CCR-TEST-26-0072', asin: 'B0TESTASIN', derivedOrderKey: orderKey,
    reservationId: 'MCFR-9F2C41AB77E0D3B5',
  };
  const envelope = {
    v: 1, suite: 'DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM', envelopeId: '33200000-0000-4000-8000-0000000000e1',
    keyId: 'b'.repeat(64), enc: creatorMcfBase64UrlEncode(Uint8Array.of(4, ...new Uint8Array(64).fill(7))),
    ciphertext: creatorMcfBase64UrlEncode(new Uint8Array(17)), mask: { countryCode: 'US', postalPrefix: '90', lines: 1 },
  };

  it('carries the binding next to the envelope and nothing that could hold plaintext', () => {
    expect(CreatorMcfSealRequest.parse({ binding, envelope })).toEqual({ binding, envelope });
    let refused = 0;
    for (const field of [...CREATOR_MCF_RECIPIENT_FIELDS, 'recipient', 'plaintext', 'phone', 'email']) {
      expect(CreatorMcfSealRequest.safeParse({ binding, envelope, [field]: 'x' }).success).toBe(false);
      expect(CreatorMcfSealRequest.safeParse({ binding: { ...binding, [field]: 'x' }, envelope }).success).toBe(false);
      refused += 2;
    }
    expect(refused).toBe(26);
    expect(CreatorMcfSealRequest.safeParse({ envelope }).success).toBe(false);
    const smuggled: unknown = JSON.parse(`{"binding":${JSON.stringify(binding)},"envelope":{"__proto__":{"name":"Canary Zq"},${JSON.stringify(envelope).slice(1)}}`);
    expect(CreatorMcfSealRequest.safeParse(smuggled).success).toBe(false);
  });

  it('accepts only the upper-case reservation id reserve_mcf issues, while the runner parse stays case-tolerant', () => {
    expect(CreatorMcfRecipientBinding.safeParse(binding).success).toBe(true);
    expect(CreatorMcfRecipientBinding.safeParse({ ...binding, reservationId: 'MCFR-LEGACY-0123456789AB' }).success).toBe(true);
    expect(CreatorMcfRecipientBinding.safeParse({ ...binding, reservationId: 'MCFR-9f2c41ab77e0d3b5' }).success).toBe(false);
    expect(CreatorMcfReservationId.safeParse('MCFR-9f2c41AB77E0D3B5').success).toBe(false);
    expect(CreatorReservationId.safeParse('MCFR-9f2c41ab77e0d3b5').success).toBe(true);
    expect(CreatorMcfSendPreview.safeParse({ ...sendPreview, reservationId: 'MCFR-9f2c41ab77e0d3b5' }).success).toBe(false);
  });
});

describe('byte helpers', () => {
  it('encodes and strictly decodes base64url (RFC 4648 section 10 vectors, URL alphabet)', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy']];
    for (const [plain, encoded] of vectors) {
      expect(creatorMcfBase64UrlEncode(utf8(plain))).toBe(encoded);
      expect(new TextDecoder().decode(creatorMcfBase64UrlDecode(encoded) ?? new Uint8Array([0]))).toBe(plain);
    }
    expect(vectors).toHaveLength(7);
    expect(creatorMcfBase64UrlEncode(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
    for (const bad of ['Zh', 'Zg==', 'Z', 'Zm9v+', 'Zm9v/', 'Zm 9v']) expect(creatorMcfBase64UrlDecode(bad)).toBeNull();
  });

  it('writes canonical JSON with sorted keys and refuses non-integers', () => {
    expect(creatorMcfCanonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"d":{"y":2,"z":1}}');
    expect(() => creatorMcfCanonicalJson({ a: 1.5 })).toThrow();
    expect(() => creatorMcfCanonicalJson({ a: new Date(0) })).toThrow();
    // eslint-disable-next-line no-sparse-arrays
    expect(() => creatorMcfCanonicalJson([, 1])).toThrow();
  });
});

describe('the send state machine (acceptance 7)', () => {
  const expected: Record<SendState, SendState[]> = {
    sealed: ['previewing', 'withdrawn', 'expired'],
    previewing: ['preview_ready', 'preview_refused', 'withdrawn', 'expired'],
    preview_ready: ['approved', 'previewing', 'withdrawn', 'expired'],
    stale: ['previewing', 'withdrawn', 'expired'],
    approved: ['dispatching', 'stale', 'withdrawn', 'accepted', 'placed', 'conflict', 'failed_by_amazon', 'expired_unclaimed', 'expired'],
    dispatching: ['accepted', 'rejected', 'uncertain'],
    accepted: ['placed', 'failed_by_amazon', 'conflict'],
    uncertain: ['accepted', 'placed', 'failed_by_amazon', 'conflict', 'not_created'],
    conflict: ['placed', 'cancel_requested', 'failed_by_amazon'],
    placed: ['failed_after_placement', 'cancel_requested'],
    cancel_requested: ['cancel_dispatching', 'placed'],
    cancel_dispatching: ['cancelled', 'placed', 'conflict'],
    preview_refused: [], withdrawn: [], expired: [], expired_unclaimed: [], rejected: [], not_created: [],
    failed_by_amazon: [], failed_after_placement: [], cancelled: [],
  };
  const TERMINAL: SendState[] = ['preview_refused', 'withdrawn', 'expired', 'expired_unclaimed', 'rejected', 'not_created',
    'failed_by_amazon', 'failed_after_placement', 'cancelled'];
  const HELD: SendState[] = ['sealed', 'previewing', 'preview_ready', 'stale', 'approved', 'dispatching'];

  it('is exactly the design table (with previewing -> withdrawn, which withdraw and supersede need)', () => {
    expect(Object.keys(CREATOR_MCF_SEND_TRANSITIONS).sort()).toEqual([...CreatorMcfSendState.options].sort());
    for (const state of CreatorMcfSendState.options) expect([...CREATOR_MCF_SEND_TRANSITIONS[state].next]).toEqual(expected[state]);
    expect(CreatorMcfSendState.options).toHaveLength(21);
    expect(Object.isFrozen(CREATOR_MCF_SEND_TRANSITIONS.approved.next)).toBe(true);
  });

  it('reaches every state from sealed', () => {
    const seen = new Set<SendState>([CREATOR_MCF_SEND_INITIAL_STATE]);
    const queue: SendState[] = [CREATOR_MCF_SEND_INITIAL_STATE];
    for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
      for (const next of CREATOR_MCF_SEND_TRANSITIONS[state].next) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    expect(seen.size).toBe(CreatorMcfSendState.options.length);
  });

  it('has the nine terminal states and no exit from any of them', () => {
    const terminal = CreatorMcfSendState.options.filter((state) => isTerminalState(state));
    expect(terminal.sort()).toEqual([...TERMINAL].sort());
    for (const state of TERMINAL) expect(CREATOR_MCF_SEND_TRANSITIONS[state].next).toHaveLength(0);
  });

  it('gives conflict exactly three exits', () => {
    expect([...CREATOR_MCF_SEND_TRANSITIONS.conflict.next].sort()).toEqual(['cancel_requested', 'failed_by_amazon', 'placed']);
  });

  it('returns a cancel that was not honoured to placed or to conflict, and enters conflict only from an outcome state or that return', () => {
    expect([...CREATOR_MCF_SEND_TRANSITIONS.cancel_dispatching.next].sort()).toEqual(['cancelled', 'conflict', 'placed']);
    expect(canTransitionCreatorMcfSend('cancel_dispatching', 'conflict')).toBe(true);
    expect(canTransitionCreatorMcfSend('cancel_requested', 'conflict')).toBe(false);
    expect(canTransitionCreatorMcfSend('cancel_dispatching', 'failed_after_placement')).toBe(false);
    // A read enters conflict from approved, accepted or uncertain; a cancel that was not honoured returns to it.
    const into = CreatorMcfSendState.options.filter((state) => canTransitionCreatorMcfSend(state, 'conflict'));
    expect(into.sort()).toEqual(['accepted', 'approved', 'cancel_dispatching', 'uncertain']);
  });

  it('holds custody in six states and never takes it back once destroyed', () => {
    expect(CreatorMcfSendState.options.filter((state) => isCustodyHeldState(state)).sort()).toEqual([...HELD].sort());
    let edges = 0;
    for (const state of CreatorMcfSendState.options) {
      for (const next of CREATOR_MCF_SEND_TRANSITIONS[state].next) {
        edges += 1;
        expect(next).not.toBe(state);
        expect(canTransitionCreatorMcfSend(state, next)).toBe(true);
        if (!isCustodyHeldState(state)) expect(isCustodyHeldState(next)).toBe(false);
      }
    }
    expect(edges).toBe(Object.values(expected).reduce((sum, next) => sum + next.length, 0));
    expect(canTransitionCreatorMcfSend('sealed', 'dispatching')).toBe(false);
    expect(canTransitionCreatorMcfSend('uncertain', 'rejected')).toBe(false);
    expect(canTransitionCreatorMcfSend('dispatching', 'expired')).toBe(false);
  });

  it('flags escalation separately from state', () => {
    expect(CreatorMcfEscalation.options).toEqual(['ladder_exhausted', 'conflict']);
  });
});

describe('classifyMcfOrderStatus (acceptance 7)', () => {
  it('classifies each of the nine v2020 statuses', () => {
    const expected = {
      New: 'awaiting_validation', Received: 'validated', Planning: 'validated', Processing: 'validated', Complete: 'validated',
      CompletePartialled: 'validated', Invalid: 'failed', Unfulfillable: 'failed', Cancelled: 'failed',
    } as const;
    expect(FulfillmentOrderStatus.options).toHaveLength(9);
    for (const status of FulfillmentOrderStatus.options) expect(classifyMcfOrderStatus(status)).toBe(expected[status]);
    expect(Object.keys(expected).sort()).toEqual([...FulfillmentOrderStatus.options].sort());
    expect(() => classifyMcfOrderStatus('Shipped' as never)).toThrow();
  });
});

const sendPreview: SendPreview = {
  previewId: '33200000-0000-4000-8000-0000000000a1', sendId: '33200000-0000-4000-8000-0000000000b1', kind: 'preview',
  derivedOrderKey: orderKey, reservationId: 'MCFR-9F2C41AB77E0D3B5', spapiConnectionId: '33200000-0000-4000-8000-0000000000c1',
  marketplaceId: 'ATVPDKIKX0DER', readAt: '2026-09-27T19:00:00Z', validUntil: '2026-09-27T19:30:00Z', workerRevision: 'test-revision-1',
  preflightRunId: 'preflight-run-1', preflightCompletedAt: '2026-09-27T18:00:00Z', asin: 'B0TESTASIN',
  items: [{ sellerSku: 'TEST-SKU-01', sellerFulfillmentOrderItemId: `${orderKey}-1`, quantity: 1 }], totalUnits: 1,
  shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', featureConstraints: [],
  existingOrder: 'none', isFulfillable: true,
  fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 399 }, { feeName: 'FBATransportationFee', amountMinor: 50 }],
    totalMinor: 449, currency: 'USD' },
  unfulfillableReasons: [], earliestArrivalDate: '2026-09-30', latestArrivalDate: '2026-10-02',
  laneFeeCapMinor: 800, grantFeeCapMinor: 1000, grantCurrency: 'USD',
  envelopeSha256: 'a'.repeat(64), keyId: 'b'.repeat(64), irreversibility: CREATOR_MCF_IRREVERSIBILITY,
};
const reread: SendPreview = { ...sendPreview, previewId: '33200000-0000-4000-8000-0000000000a2', kind: 'dispatch_reread',
  readAt: '2026-09-27T19:10:00Z', validUntil: '2026-09-27T19:40:00Z', workerRevision: 'test-revision-2' };
const cancelPreview = {
  previewId: '33200000-0000-4000-8000-0000000000a3', sendId: sendPreview.sendId, kind: 'cancel_preview', derivedOrderKey: orderKey,
  reservationId: sendPreview.reservationId, spapiConnectionId: sendPreview.spapiConnectionId, marketplaceId: sendPreview.marketplaceId,
  readAt: '2026-09-28T09:00:00Z', validUntil: '2026-09-28T09:05:00Z', workerRevision: 'test-revision-2',
  existingOrder: { status: 'Received' }, items: sendPreview.items, totalUnits: 1,
} as const;

describe('CreatorMcfPreview (acceptance 6)', () => {
  const FORBIDDEN_KEYS = [...CREATOR_MCF_RECIPIENT_FIELDS, 'phone', 'email', 'mask', 'postalPrefix', 'lines', 'destinationAddress', 'recipient'];

  it('accepts a send preview, a dispatch re-read and a cancel preview', () => {
    expect(CreatorMcfPreview.parse(sendPreview)).toEqual(sendPreview);
    expect(CreatorMcfPreview.safeParse(reread).success).toBe(true);
    expect(CreatorMcfPreview.safeParse(cancelPreview).success).toBe(true);
  });

  it('refuses every recipient or mask field name, at the top level and inside every nested object', () => {
    const fees = sendPreview.fees ?? { parts: [], totalMinor: 0, currency: 'USD' };
    const firstItem = sendPreview.items[0] ?? { sellerSku: 'x', sellerFulfillmentOrderItemId: 'x', quantity: 1 };
    const firstPart = fees.parts[0] ?? { feeName: 'x', amountMinor: 0 };
    const places: ((key: string) => unknown)[] = [
      (key) => ({ ...sendPreview, [key]: 'Canary Zq' }),
      (key) => ({ ...sendPreview, items: [{ ...firstItem, [key]: 'Canary Zq' }] }),
      (key) => ({ ...sendPreview, fees: { ...fees, [key]: 'Canary Zq' } }),
      (key) => ({ ...sendPreview, fees: { ...fees, parts: [{ ...firstPart, [key]: 'Canary Zq' }, ...fees.parts.slice(1)] } }),
      (key) => ({ ...cancelPreview, [key]: 'Canary Zq' }),
      (key) => ({ ...cancelPreview, existingOrder: { status: 'Received', [key]: 'Canary Zq' } }),
    ];
    let refused = 0;
    for (const key of FORBIDDEN_KEYS) {
      for (const place of places) {
        expect(CreatorMcfPreview.safeParse(place(key)).success).toBe(false);
        refused += 1;
      }
    }
    expect(refused).toBe(FORBIDDEN_KEYS.length * places.length);
  });

  it('declares no recipient or mask field name anywhere in its shape', () => {
    const keys: string[] = [];
    const walk = (schema: unknown): void => {
      const shape = (schema as { shape?: Record<string, unknown> }).shape;
      if (shape !== undefined) {
        for (const [key, child] of Object.entries(shape)) { keys.push(key); walk(child); }
      }
      const def = (schema as { def?: { element?: unknown; innerType?: unknown; options?: unknown[] } }).def;
      if (def?.element !== undefined) walk(def.element);
      if (def?.innerType !== undefined) walk(def.innerType);
      for (const option of def?.options ?? []) walk(option);
    };
    walk(CreatorMcfPreview);
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((key) => FORBIDDEN_KEYS.includes(key))).toEqual([]);
  });

  it('refuses inconsistent previews', () => {
    const cases: unknown[] = [
      { ...sendPreview, totalUnits: 2 },
      { ...sendPreview, items: [{ ...sendPreview.items[0], sellerFulfillmentOrderItemId: `CCS-${'f'.repeat(32)}-1` }] },
      { ...sendPreview, fees: { ...sendPreview.fees, totalMinor: 450 } },
      { ...sendPreview, fees: null },
      { ...sendPreview, unfulfillableReasons: ['InvalidDestinationAddress'] },
      { ...sendPreview, validUntil: '2026-09-27T19:31:00Z' },
      { ...sendPreview, validUntil: sendPreview.readAt },
      { ...sendPreview, latestArrivalDate: '2026-09-29' },
      { ...sendPreview, featureConstraints: ['BLANK_BOX'] },
      { ...sendPreview, shippingSpeedCategory: 'Expedited' },
      { ...sendPreview, irreversibility: 'Arcana can undo this.' },
      { ...cancelPreview, existingOrder: { status: 'Processing' } },
      { ...cancelPreview, validUntil: '2026-09-28T09:06:00Z' },
    ];
    let refused = 0;
    for (const candidate of cases) {
      expect(CreatorMcfPreview.safeParse(candidate).success).toBe(false);
      refused += 1;
    }
    expect(refused).toBe(13);
    expect(CreatorMcfSendPreview.safeParse({ ...sendPreview, isFulfillable: false, fees: null, unfulfillableReasons: ['InvalidDestinationAddress'] }).success).toBe(true);
    expect(CreatorMcfCancelPreview.safeParse({ ...cancelPreview, existingOrder: { status: 'Planning' } }).success).toBe(true);
  });
});

describe('fingerprint and re-read comparison (acceptance 8)', () => {
  const withFees = (parts: { feeName: string; amountMinor: number }[], currency = 'USD'): SendPreview => ({
    ...reread, fees: { parts, totalMinor: parts.reduce((sum, part) => sum + part.amountMinor, 0), currency },
  });

  it('finds no difference in an identical re-read, whatever the order of items, fee parts or reasons', () => {
    expect(creatorMcfPreviewsDiffer(sendPreview, reread)).toEqual([]);
    expect(creatorMcfPreviewsDiffer(sendPreview, withFees([...(sendPreview.fees?.parts ?? [])].reverse()))).toEqual([]);
    const unfulfillable = { ...sendPreview, isFulfillable: false, unfulfillableReasons: ['A', 'B'] };
    expect(creatorMcfPreviewsDiffer(unfulfillable, { ...reread, isFulfillable: false, unfulfillableReasons: ['B', 'A'] })).toEqual([]);
  });

  it('flags a fee decrease, a fee increase, a currency change, a changed reason set and a changed arrival day', () => {
    const cases: [SendPreview, SendPreview, string[]][] = [
      [sendPreview, withFees([{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 349 }, { feeName: 'FBATransportationFee', amountMinor: 50 }]),
        ['fees.parts', 'fees.totalMinor']],
      [sendPreview, withFees([{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 449 }, { feeName: 'FBATransportationFee', amountMinor: 50 }]),
        ['fees.parts', 'fees.totalMinor']],
      [sendPreview, withFees(sendPreview.fees?.parts ?? [], 'CAD'), ['fees.currency']],
      [{ ...sendPreview, isFulfillable: false, unfulfillableReasons: ['A'] }, { ...reread, isFulfillable: false, unfulfillableReasons: ['B'] },
        ['unfulfillableReasons']],
      [sendPreview, { ...reread, isFulfillable: false, unfulfillableReasons: ['InvalidDestinationAddress'] },
        ['isFulfillable', 'unfulfillableReasons']],
      [sendPreview, { ...reread, latestArrivalDate: '2026-10-03' }, ['latestArrivalDate']],
      [sendPreview, { ...reread, earliestArrivalDate: '2026-10-01' }, ['earliestArrivalDate']],
      [sendPreview, { ...reread, fees: null, isFulfillable: false }, ['isFulfillable', 'fees']],
      [sendPreview, { ...reread, envelopeSha256: 'c'.repeat(64), laneFeeCapMinor: 700 }, ['laneFeeCapMinor', 'envelopeSha256']],
      [sendPreview, { ...reread, items: [{ ...reread.items[0], sellerSku: 'TEST-SKU-02' }] } as SendPreview, ['items']],
    ];
    for (const [approved, again, fields] of cases) expect(creatorMcfPreviewsDiffer(approved, again)).toEqual(fields);
    expect(cases).toHaveLength(10);
    expect(creatorMcfPreviewsDiffer(sendPreview, CreatorMcfPreview.parse(cancelPreview))).toEqual(['kind']);
  });

  it('fingerprints the whole preview: stable across key order, different after any change', async () => {
    const reordered = Object.fromEntries(Object.entries(sendPreview).reverse()) as SendPreview;
    const fingerprint = await creatorMcfPreviewFingerprint(sendPreview);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await creatorMcfPreviewFingerprint(reordered)).toBe(fingerprint);
    expect(await creatorMcfPreviewFingerprint(reread)).not.toBe(fingerprint);
    expect(await creatorMcfPreviewFingerprint({ ...sendPreview, laneFeeCapMinor: 801 })).not.toBe(fingerprint);
  });
});

describe('confirmation wording (acceptance 4)', () => {
  it('reads "Send 1 unit via Amazon" and "Send 2 units via Amazon"', () => {
    expect(creatorMcfSendConfirmation(1)).toBe('Send 1 unit via Amazon');
    expect(creatorMcfSendConfirmation(2)).toBe('Send 2 units via Amazon');
    expect(creatorMcfCancelConfirmation(1)).toBe('Cancel 1 order in Amazon');
    expect(creatorMcfCancelConfirmation(2)).toBe('Cancel 2 orders in Amazon');
  });

  it('covers 1 to 20 and throws for 0, 21 and non-integers', () => {
    const rows = Array.from({ length: CREATOR_MCF_MAX_UNITS }, (_, index) => index + 1);
    for (const units of rows) {
      expect(creatorMcfSendConfirmation(units)).toBe(units === 1 ? 'Send 1 unit via Amazon' : `Send ${units} units via Amazon`);
      expect(creatorMcfCancelConfirmation(units)).toBe(units === 1 ? 'Cancel 1 order in Amazon' : `Cancel ${units} orders in Amazon`);
    }
    expect(rows).toHaveLength(20);
    for (const bad of [0, 21, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => creatorMcfSendConfirmation(bad)).toThrow(RangeError);
      expect(() => creatorMcfCancelConfirmation(bad)).toThrow(RangeError);
    }
  });

  it('binds the approval\'s confirmation to its unit count', () => {
    const approval = { sendId: sendPreview.sendId, previewId: sendPreview.previewId, previewFingerprint: 'd'.repeat(64), totalUnits: 1,
      confirmation: 'Send 1 unit via Amazon', requestId: '33200000-0000-4000-8000-0000000000f1' };
    expect(CreatorMcfSendApproval.safeParse(approval).success).toBe(true);
    for (const confirmation of ['Send 1 units via Amazon', 'Send 2 units via Amazon', 'Yes, ship 1 sample to this creator through Amazon', 'send 1 unit via amazon']) {
      expect(CreatorMcfSendApproval.safeParse({ ...approval, confirmation }).success).toBe(false);
    }
    expect(CreatorMcfSendApproval.safeParse({ ...approval, totalUnits: 2, confirmation: 'Send 2 units via Amazon' }).success).toBe(true);
    expect(CreatorMcfSendApproval.safeParse({ ...approval, totalUnits: 21, confirmation: 'Send 21 units via Amazon' }).success).toBe(false);
  });
});

describe('fixed texts', () => {
  it('keeps the packing-slip comment fixed, short and free of creator data', () => {
    expect(CREATOR_MCF_PACKING_SLIP_COMMENT.length).toBeGreaterThan(0);
    expect(CREATOR_MCF_PACKING_SLIP_COMMENT.length).toBeLessThanOrEqual(750);
    expect(CREATOR_MCF_PACKING_SLIP_COMMENT).not.toMatch(/[0-9@{}$]/);
    expect(CREATOR_MCF_IRREVERSIBILITY).toBe('Arcana cannot delete an Amazon order. It can ask Amazon to cancel only while the order is Received or Planning.');
  });
});

describe('CreatorMcfProviderOutcome', () => {
  it('keeps codes only and ties reason and cause to the HTTP status', () => {
    const valid: unknown[] = [
      { outcome: 'accepted', status: 200 },
      { outcome: 'rejected', status: 400, codes: ['InvalidInput'], reason: 'validation' },
      { outcome: 'rejected', status: 404, codes: [], reason: 'validation' },
      { outcome: 'rejected', status: 429, codes: ['QuotaExceeded'], reason: 'throttled' },
      { outcome: 'rejected', status: 403, codes: ['Unauthorized'], reason: 'authorization' },
      { outcome: 'uncertain', cause: 'transport', status: null },
      { outcome: 'uncertain', cause: 'crash', status: null },
      { outcome: 'uncertain', cause: 'http_5xx', status: 503 },
      { outcome: 'uncertain', cause: 'http_408', status: 408 },
      { outcome: 'uncertain', cause: 'decode', status: 200 },
    ];
    const invalid: unknown[] = [
      { outcome: 'accepted', status: 201 },
      { outcome: 'rejected', status: 408, codes: [], reason: 'validation' },
      { outcome: 'rejected', status: 429, codes: [], reason: 'validation' },
      { outcome: 'rejected', status: 400, codes: [], reason: 'throttled' },
      { outcome: 'rejected', status: 401, codes: [], reason: 'other' },
      { outcome: 'rejected', status: 400, codes: ['has space canary'], reason: 'validation' },
      { outcome: 'rejected', status: 400, codes: [], reason: 'validation', message: 'free text' },
      { outcome: 'uncertain', cause: 'transport', status: 500 },
      { outcome: 'uncertain', cause: 'http_5xx', status: 400 },
      { outcome: 'uncertain', cause: 'http_408', status: null },
    ];
    for (const outcome of valid) expect(CreatorMcfProviderOutcome.safeParse(outcome).success).toBe(true);
    for (const outcome of invalid) expect(CreatorMcfProviderOutcome.safeParse(outcome).success).toBe(false);
    expect([valid.length, invalid.length]).toEqual([10, 10]);
  });
});

describe('CreatorMcfSendCounts', () => {
  const counts = {
    claimed: 9, previewed: 2, previewRefused: 1, previewRefusedRecipient: 1, stale: 1, foundBeforePost: 1, posted: 2, deferred: 1, expired: 1,
    accepted: 1, rejected: 0, uncertain: 1, custodyDestroyed: 6,
    unitsRequested: 6, unitsAccepted: 1, unitsRejected: 0, unitsUncertain: 1, unitsStale: 1, unitsFoundBeforePost: 1, unitsDeferred: 1,
    unitsExpired: 1, readThrottled: 4,
  };

  it('accepts reconciling counts and names each broken invariant', () => {
    expect(() => assertCreatorMcfCounts(counts)).not.toThrow();
    expect(CreatorMcfSendCounts.parse(counts)).toEqual(counts);
    const broken: [Partial<typeof counts>, string][] = [
      [{ claimed: 10 }, 'claimed = previewed'],
      [{ posted: 3, claimed: 10 }, 'posted = accepted + rejected + uncertain'],
      [{ previewRefusedRecipient: 2, custodyDestroyed: 7 }, 'previewRefusedRecipient <= previewRefused'],
      [{ custodyDestroyed: 4 }, 'custodyDestroyed >= '],
      [{ unitsRequested: 7 }, 'unitsRequested = '],
    ];
    for (const [change, invariant] of broken) expect(() => assertCreatorMcfCounts({ ...counts, ...change })).toThrow(invariant);
    expect(broken).toHaveLength(5);
    expect(() => assertCreatorMcfCounts({ ...counts, readThrottled: 0 })).not.toThrow();
    expect(() => assertCreatorMcfCounts({ ...counts, extra: 0 })).toThrow();
    expect(() => assertCreatorMcfCounts({ ...counts, stale: -1, claimed: 7 })).toThrow();
  });
});

describe('refinements are total', () => {
  it('returns a result, never throws, when any field of any schema holds a hostile value', () => {
    const hostile: unknown[] = [null, undefined, 0, -1, 1.5, 21, '', 'x', true, {}, [], [null], [{}], { length: 1 }];
    const approval = { sendId: sendPreview.sendId, previewId: sendPreview.previewId, previewFingerprint: 'd'.repeat(64), totalUnits: 1,
      confirmation: 'Send 1 unit via Amazon', requestId: '33200000-0000-4000-8000-0000000000f1' };
    const outcome = { derivedOrderKey: orderKey, state: 'placed', class: 'placed', escalated: false, mcfStatus: 'Received',
      acceptedAt: null, placedAt: '2026-09-27T19:13:00Z', reservationId: 'MCFR-9F2C41AB77E0D3B5' };
    const counts = Object.fromEntries(['claimed', 'previewed', 'previewRefused', 'previewRefusedRecipient', 'stale', 'foundBeforePost',
      'posted', 'deferred', 'expired', 'accepted', 'rejected', 'uncertain', 'custodyDestroyed', 'unitsRequested', 'unitsAccepted',
      'unitsRejected', 'unitsUncertain', 'unitsStale', 'unitsFoundBeforePost', 'unitsDeferred', 'unitsExpired', 'readThrottled'].map((key) => [key, 0]));
    const subjects: [{ safeParse: (input: unknown) => unknown }, Record<string, unknown>][] = [
      [CreatorMcfRecipient, recipient], [CreatorMcfPreview, sendPreview], [CreatorMcfPreview, cancelPreview],
      [CreatorMcfSendApproval, approval], [CreatorMcfSendOutcome, outcome], [CreatorMcfSendCounts, counts],
      [CreatorMcfProviderOutcome, { outcome: 'rejected', status: 400, codes: [], reason: 'validation' }],
      [CreatorMcfProviderOutcome, { outcome: 'uncertain', cause: 'decode', status: null }],
      [CreatorMcfSealedRecipient, { v: 1, suite: 'x', envelopeId: 'x', keyId: 'x', enc: 'x', ciphertext: 'x', mask: {} }],
    ];
    let probes = 0;
    for (const [schema, base] of subjects) {
      for (const key of Object.keys(base)) {
        for (const value of hostile) {
          expect(() => schema.safeParse({ ...base, [key]: value })).not.toThrow();
          probes += 1;
        }
      }
      for (const nested of ['items', 'fees'] as const) {
        if (!(nested in base)) continue;
        for (const value of hostile) {
          expect(() => schema.safeParse({ ...base, [nested]: [value], fees: { parts: [value], totalMinor: 0, currency: 'USD' } })).not.toThrow();
          probes += 1;
        }
      }
      for (const value of hostile) expect(() => creatorMcfRecipientIssues(value)).not.toThrow();
    }
    expect(probes).toBeGreaterThan(500);
  });
});

describe('CreatorMcfSendOutcome (the MCP read)', () => {
  const outcome = { derivedOrderKey: orderKey, state: 'placed', class: 'placed', escalated: false, mcfStatus: 'Received',
    acceptedAt: '2026-09-27T19:12:00Z', placedAt: '2026-09-27T19:13:00Z', reservationId: 'MCFR-9F2C41AB77E0D3B5' };

  it('derives the class from the state and carries no recipient data', () => {
    expect(CreatorMcfSendOutcome.safeParse(outcome).success).toBe(true);
    expect(CreatorMcfSendOutcome.safeParse({ ...outcome, class: 'pending' }).success).toBe(false);
    expect(CreatorMcfSendOutcome.safeParse({ ...outcome, placedAt: null }).success).toBe(false);
    expect(CreatorMcfSendOutcome.safeParse({ ...outcome, mask: { countryCode: 'US', postalPrefix: '90', lines: 1 } }).success).toBe(false);
    expect(CreatorMcfSendOutcome.safeParse({ ...outcome, state: 'conflict', class: 'uncertain', escalated: true, placedAt: null }).success).toBe(true);
    const classes = new Set(CreatorMcfSendState.options.map((state) => creatorMcfSendOutcomeClass(state)));
    expect([...classes].sort()).toEqual([...CreatorMcfSendOutcomeClass.options].sort());
    expect(creatorMcfSendOutcomeClass('failed_by_amazon')).toBe('failed');
    expect(creatorMcfSendOutcomeClass('cancelled')).toBe('cancelled');
  });
});
