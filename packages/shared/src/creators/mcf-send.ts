/**
 * Creator Connections round 3b (WP-338): the contracts for Arcana sending a
 * sample unit through Amazon Multi-Channel Fulfillment (SP-API Fulfillment
 * Outbound v2020-07-01).
 *
 * The operator types the creator's address in the browser. The browser checks it
 * against `CreatorMcfRecipient`, seals it to the MCF worker's public key
 * (`./mcf-envelope.ts`) and posts only the `CreatorMcfSealedRecipient`. No other
 * shape in this file holds a recipient attribute: the preview, the approval, the
 * outcome, the counts and the MCP read carry ids, codes and numbers only.
 *
 * Creating an Amazon order is an Amazon write. It follows the ten clauses of the
 * Amazon write contract in AGENTS.md; this file supplies the pieces those clauses
 * name: the immutable address-free preview, the exact confirmation wording, the
 * send state machine and the reconciling counts.
 */
import { z } from 'zod';
import { FulfillmentOrderStatus } from '../spapi-fulfillment.js';
import { CreatorSampleOrderKey } from './model.js';
import { CreatorAsin, CreatorRecordId, CreatorReservationId } from './runner.js';

// ---------------------------------------------------------------------------
// Byte helpers shared by this file and ./mcf-envelope.ts. WebCrypto only, so
// the same code runs in the browser and in the worker.
// ---------------------------------------------------------------------------

/** RFC 4648 Table 2, in three runs. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789-_';

/** RFC 4648 section 5 base64url, unpadded. */
export function creatorMcfBase64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const word = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out += BASE64URL_ALPHABET.charAt((word >> 18) & 63) + BASE64URL_ALPHABET.charAt((word >> 12) & 63)
      + BASE64URL_ALPHABET.charAt((word >> 6) & 63) + BASE64URL_ALPHABET.charAt(word & 63);
  }
  const rest = bytes.length - index;
  if (rest > 0) {
    const word = ((bytes[index] ?? 0) << 16) | (rest === 2 ? (bytes[index + 1] ?? 0) << 8 : 0);
    out += BASE64URL_ALPHABET.charAt((word >> 18) & 63) + BASE64URL_ALPHABET.charAt((word >> 12) & 63);
    if (rest === 2) out += BASE64URL_ALPHABET.charAt((word >> 6) & 63);
  }
  return out;
}

/**
 * Strict base64url decoding: URL alphabet only, no padding, and the unused
 * trailing bits must be zero, so every byte string has exactly one accepted
 * text. Returns null for any other input.
 */
export function creatorMcfBase64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < text.length; index += 1) {
    const value = BASE64URL_ALPHABET.indexOf(text.charAt(index));
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  return buffer === 0 ? out : null;
}

/** Lower-case hex. */
export function creatorMcfHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether an own "__proto__" key (which JSON.parse creates) appears anywhere in the first few levels. */
function hasOwnProtoKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || typeof value !== 'object' || value === null) return false;
  if (Object.hasOwn(value, '__proto__')) return true;
  return Object.values(value).some((child: unknown) => hasOwnProtoKey(child, depth + 1));
}

/**
 * A strict zod object drops an own "__proto__" key silently instead of
 * refusing it. Wire inputs run through this first, so such a key is refused
 * like any other unknown key.
 */
function refuseOwnProtoKey(value: unknown, ctx: z.RefinementCtx): unknown {
  if (hasOwnProtoKey(value)) ctx.addIssue({ code: 'custom', message: 'a "__proto__" key is not accepted', params: { rule: 'unknown_field' } });
  return value;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
 * undefined members dropped, integers only. For the values these contracts
 * allow (strings, safe integers, booleans, null, arrays and plain objects) this
 * is RFC 8785 (JCS). Anything else throws, with no value in the message.
 */
export function creatorMcfCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON holds safe integers only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value as unknown[], (item) => creatorMcfCanonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${creatorMcfCanonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError('canonical JSON cannot hold this value');
}

/** Hex SHA-256 through WebCrypto. */
export async function creatorMcfSha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return creatorMcfHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

// ---------------------------------------------------------------------------
// Shared field shapes.
// ---------------------------------------------------------------------------

const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
/** Lower-case RFC 9562 uuid, so the associated data has one spelling. */
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'expected a lower-case uuid');
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex characters');
/** The only form in which provider codes are kept (DESIGN §4.5): no free text. */
const ProviderCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/, 'expected a provider code');
const Currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code');
const MinorAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Printable ASCII with no leading or trailing space, at most 40 characters (the model's seller SKU limit). */
const SellerSku = z.string().regex(/^[\x21-\x7e](?:[\x20-\x7e]{0,38}[\x21-\x7e])?$/, 'expected a seller SKU');
const MarketplaceId = z.string().regex(/^[A-Z0-9]{9,16}$/, 'expected a marketplace id');
const WorkerRevision = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'expected a worker revision');
/** The control runner's pre-flight run id, the same pattern WP-334 accepts. */
const PreflightRunId = z.string().regex(/^[A-Za-z0-9:_.-]{1,80}$/, 'expected a run id of letters, digits and : _ . -');

/** The most units one send may carry. The grant's daily cap is at most the same. */
export const CREATOR_MCF_MAX_UNITS = 20;
const Units = z.number().int().min(1).max(CREATOR_MCF_MAX_UNITS);

// ---------------------------------------------------------------------------
// The recipient: plaintext that exists only in the operator's tab and, once
// opened, in the MCF worker's memory.
// ---------------------------------------------------------------------------

/** The v2020 `Address` fields Arcana accepts, in the order a label prints them. */
export const CREATOR_MCF_RECIPIENT_FIELDS = [
  'name', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'districtOrCounty', 'stateOrRegion', 'postalCode', 'countryCode',
] as const;
export type CreatorMcfRecipientField = (typeof CREATOR_MCF_RECIPIENT_FIELDS)[number];

/**
 * No control, invisible format (bidi overrides, zero-width characters), line
 * separator or unpaired-surrogate characters. The review panel must show
 * exactly what Amazon receives, and these would hide text, reorder it or not
 * survive UTF-8.
 */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]*$/u;
/** Arcana's own limit. The model sets no maxLength on any Address field. */
const AddressText = z.string().trim().min(1).max(60).regex(PRINTABLE, 'control and invisible format characters are not allowed');

/**
 * The address the operator types. Strict: phone, email and any other key are
 * refused. `city` is required except in Japan (the model's rule);
 * `stateOrRegion` is required for the US (Arcana's rule; the model marks it
 * optional). Strings are trimmed, so the sealed plaintext is the trimmed form.
 * Whether `countryCode` belongs to the grant's marketplace is checked where the
 * grant is known.
 */
export const CreatorMcfRecipient = z.preprocess(refuseOwnProtoKey, z.object({
  name: AddressText,
  addressLine1: AddressText,
  addressLine2: AddressText.optional(),
  addressLine3: AddressText.optional(),
  city: AddressText.optional(),
  districtOrCounty: AddressText.optional(),
  stateOrRegion: AddressText.optional(),
  postalCode: z.string().trim().min(2).max(20)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9 -]*[A-Za-z0-9])?$/, 'letters, digits, spaces and hyphens only'),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'expected an ISO 3166-1 alpha-2 code'),
}).strict()).superRefine((recipient, ctx) => {
  if (recipient.countryCode !== 'JP' && recipient.city === undefined) {
    ctx.addIssue({ code: 'custom', path: ['city'], message: 'city is required outside Japan', params: { rule: 'city_required' } });
  }
  if (recipient.countryCode === 'US' && recipient.stateOrRegion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['stateOrRegion'], message: 'state is required for a US address', params: { rule: 'state_required' } });
  }
});
export type CreatorMcfRecipient = z.infer<typeof CreatorMcfRecipient>;

/**
 * What may be shown and stored about a sealed address: country, the first two
 * postal characters and the number of address lines. It is bound into the
 * envelope's associated data and recomputed by the worker after opening.
 */
export const CreatorMcfMask = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  postalPrefix: z.string().regex(/^[A-Z0-9][A-Z0-9 -]$/),
  lines: z.number().int().min(1).max(3),
}).strict();
export type CreatorMcfMask = z.infer<typeof CreatorMcfMask>;

/** The mask of an already validated recipient. */
export function creatorMcfMask(recipient: CreatorMcfRecipient): CreatorMcfMask {
  const lines = 1 + (recipient.addressLine2 === undefined ? 0 : 1) + (recipient.addressLine3 === undefined ? 0 : 1);
  return { countryCode: recipient.countryCode, postalPrefix: recipient.postalCode.slice(0, 2).toUpperCase(), lines };
}

/** Why a recipient was refused, as a fixed code. */
export const CreatorMcfRecipientRule = z.enum([
  'required', 'invalid_type', 'too_short', 'too_long', 'invalid_format', 'invalid_value',
  'unknown_field', 'forbidden_field', 'city_required', 'state_required', 'malformed',
]);
export type CreatorMcfRecipientRule = z.infer<typeof CreatorMcfRecipientRule>;
const CUSTOM_RULES: ReadonlySet<string> = new Set(['city_required', 'state_required', 'unknown_field']);
/**
 * One refusal: a field name from a fixed list (or null) and a rule code. Never
 * a value and never an unknown key's name, since either could be address text.
 */
export const CreatorMcfRecipientIssue = z.object({
  field: z.enum([...CREATOR_MCF_RECIPIENT_FIELDS, 'phone', 'email']).nullable(),
  rule: CreatorMcfRecipientRule,
}).strict();
export type CreatorMcfRecipientIssue = z.infer<typeof CreatorMcfRecipientIssue>;

const ISSUE_FIELD_ORDER: readonly (CreatorMcfRecipientIssue['field'])[] = [...CREATOR_MCF_RECIPIENT_FIELDS, 'phone', 'email', null];

/**
 * The refusals for a candidate recipient, sorted and without duplicates; empty
 * when it is valid. Safe to log, persist or return to the browser.
 */
export function creatorMcfRecipientIssues(input: unknown): CreatorMcfRecipientIssue[] {
  try {
    return recipientIssues(input);
  } catch {
    return [{ field: null, rule: 'malformed' }];
  }
}

function recipientIssues(input: unknown): CreatorMcfRecipientIssue[] {
  const result = CreatorMcfRecipient.safeParse(input);
  if (result.success) return [];
  const present = (field: string): boolean => isPlainObject(input) && Object.hasOwn(input, field) && input[field] !== undefined;
  const blank = (field: string): boolean => {
    const value = isPlainObject(input) ? input[field] : undefined;
    return typeof value === 'string' && value.trim() === '';
  };
  const known = (segment: unknown): CreatorMcfRecipientField | null =>
    typeof segment === 'string' && (CREATOR_MCF_RECIPIENT_FIELDS as readonly string[]).includes(segment) ? segment as CreatorMcfRecipientField : null;
  const found = new Map<string, CreatorMcfRecipientIssue>();
  const add = (issue: CreatorMcfRecipientIssue): void => { found.set(`${issue.field ?? ''}|${issue.rule}`, issue); };
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const lower = key.toLowerCase();
        if (lower.includes('phone')) add({ field: 'phone', rule: 'forbidden_field' });
        else if (lower.includes('email')) add({ field: 'email', rule: 'forbidden_field' });
        else add({ field: null, rule: 'unknown_field' });
      }
      continue;
    }
    const field = known(issue.path[0]);
    if (issue.code === 'custom') {
      const rule: unknown = issue.params?.['rule'];
      add({ field, rule: typeof rule === 'string' && CUSTOM_RULES.has(rule) ? rule as CreatorMcfRecipientRule : 'invalid_value' });
      continue;
    }
    if (issue.path.length === 0) { add({ field: null, rule: 'malformed' }); continue; }
    if (field !== null && blank(field)) { add({ field, rule: 'required' }); continue; }
    switch (issue.code) {
      case 'invalid_type': add({ field, rule: field !== null && !present(field) ? 'required' : 'invalid_type' }); break;
      case 'too_small': add({ field, rule: 'too_short' }); break;
      case 'too_big': add({ field, rule: 'too_long' }); break;
      case 'invalid_format': add({ field, rule: 'invalid_format' }); break;
      default: add({ field, rule: 'invalid_value' });
    }
  }
  const rank = (issue: CreatorMcfRecipientIssue): number => ISSUE_FIELD_ORDER.indexOf(issue.field) * 100
    + CreatorMcfRecipientRule.options.indexOf(issue.rule);
  return [...found.values()].sort((left, right) => rank(left) - rank(right));
}

// ---------------------------------------------------------------------------
// The sealed envelope and its associated data.
// ---------------------------------------------------------------------------

/** RFC 9180 Appendix A.3: mode_base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. */
export const CREATOR_MCF_ENVELOPE_SUITE = 'DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM';
/** Ciphertext bounds including the 16-byte tag; the custody column holds 17 to 4,096 bytes. */
export const CREATOR_MCF_CIPHERTEXT_MIN_BYTES = 17;
export const CREATOR_MCF_CIPHERTEXT_MAX_BYTES = 4096;
/** An uncompressed P-256 point: 0x04, x, y. */
export const CREATOR_MCF_ENC_BYTES = 65;

const base64UrlBytes = (min: number, max: number, message: string) => z.string()
  .max(Math.ceil((max * 4) / 3))
  .regex(/^[A-Za-z0-9_-]+$/, 'expected unpadded base64url')
  .refine((text) => {
    if (text.length > Math.ceil((max * 4) / 3)) return false;
    const bytes = creatorMcfBase64UrlDecode(text);
    return bytes !== null && bytes.length >= min && bytes.length <= max;
  }, message);

/** Hex SHA-256 of the recipient public key's SPKI DER. */
export const CreatorMcfKeyId = Hex64;
export type CreatorMcfKeyId = z.infer<typeof CreatorMcfKeyId>;

/** The worker's recipient public key as a JWK. A private member (`d`) or any other key is refused. */
export const CreatorMcfRecipientPublicJwk = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64UrlBytes(32, 32, 'expected a 32-byte coordinate'),
  y: base64UrlBytes(32, 32, 'expected a 32-byte coordinate'),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string().max(32)).max(8).optional(),
  alg: z.string().max(32).optional(),
  use: z.literal('enc').optional(),
  kid: z.string().max(128).optional(),
}).strict();
export type CreatorMcfRecipientPublicJwk = z.infer<typeof CreatorMcfRecipientPublicJwk>;

/**
 * What the browser posts: no plaintext field exists. `enc` is the ephemeral
 * public key, `ciphertext` includes the AES-GCM tag, and `mask` is bound into
 * the associated data.
 */
export const CreatorMcfSealedRecipient = z.preprocess(refuseOwnProtoKey, z.object({
  v: z.literal(1),
  suite: z.literal(CREATOR_MCF_ENVELOPE_SUITE),
  envelopeId: Uuid,
  keyId: CreatorMcfKeyId,
  enc: base64UrlBytes(CREATOR_MCF_ENC_BYTES, CREATOR_MCF_ENC_BYTES, 'expected a 65-byte uncompressed point')
    .refine((text) => creatorMcfBase64UrlDecode(text)?.[0] === 0x04, 'expected an uncompressed point'),
  ciphertext: base64UrlBytes(CREATOR_MCF_CIPHERTEXT_MIN_BYTES, CREATOR_MCF_CIPHERTEXT_MAX_BYTES, 'ciphertext must be 17 to 4,096 bytes'),
  mask: CreatorMcfMask,
}).strict());
export type CreatorMcfSealedRecipient = z.infer<typeof CreatorMcfSealedRecipient>;

/**
 * The one spelling `reserve_mcf` issues (`MCFR-` plus 16 upper-case hex, or
 * the legacy `MCFR-LEGACY-` plus 12), since the id is bound into the
 * associated data. The runner-file parse (`CreatorReservationId`) stays
 * case-tolerant.
 */
export const CreatorMcfReservationId = CreatorReservationId.regex(/^MCFR-(?:[0-9A-F]{16}|LEGACY-[0-9A-F]{12})$/,
  'expected the upper-case reservation id reserve_mcf issues');
export type CreatorMcfReservationId = z.infer<typeof CreatorMcfReservationId>;

/** The lane an envelope is sealed for. The database supplies the same values when the worker opens it. */
export const CreatorMcfRecipientBinding = z.object({
  orgId: Uuid,
  creatorRecordId: CreatorRecordId,
  asin: CreatorAsin,
  derivedOrderKey: CreatorSampleOrderKey,
  reservationId: CreatorMcfReservationId,
}).strict();
export type CreatorMcfRecipientBinding = z.infer<typeof CreatorMcfRecipientBinding>;

/**
 * What the browser's server action receives: the lane the envelope was sealed
 * for, next to the envelope. The seal RPC compares `binding` with the lane
 * (organisation, record, ASIN, derived order key, reservation) before it
 * stores anything. No field can hold plaintext.
 */
export const CreatorMcfSealRequest = z.preprocess(refuseOwnProtoKey, z.object({
  binding: CreatorMcfRecipientBinding,
  envelope: CreatorMcfSealedRecipient,
}).strict());
export type CreatorMcfSealRequest = z.infer<typeof CreatorMcfSealRequest>;

/** Every associated-data field: the binding plus the envelope's own id, key id and mask. */
export const CreatorMcfRecipientAadFields = CreatorMcfRecipientBinding.extend({
  envelopeId: Uuid,
  keyId: CreatorMcfKeyId,
  mask: CreatorMcfMask,
}).strict();
export type CreatorMcfRecipientAadFields = z.infer<typeof CreatorMcfRecipientAadFields>;

/**
 * The AEAD associated data: UTF-8 canonical JSON of `{v: 1, ...fields}` with
 * keys sorted, for example
 * `{"asin":…,"creatorRecordId":…,"derivedOrderKey":…,"envelopeId":…,"keyId":…,"mask":{"countryCode":…,"lines":2,"postalPrefix":…},"orgId":…,"reservationId":…,"v":1}`.
 * Throws a ZodError when a field is out of shape.
 */
export function creatorMcfRecipientAad(fields: CreatorMcfRecipientAadFields): Uint8Array<ArrayBuffer> {
  const parsed = CreatorMcfRecipientAadFields.parse(fields);
  return new TextEncoder().encode(creatorMcfCanonicalJson({ v: 1, ...parsed }));
}

// ---------------------------------------------------------------------------
// The send state machine, as data.
// ---------------------------------------------------------------------------

export const CreatorMcfSendState = z.enum([
  'sealed', 'previewing', 'preview_ready', 'stale', 'approved', 'dispatching',
  'accepted', 'uncertain', 'conflict', 'placed', 'cancel_requested', 'cancel_dispatching',
  'preview_refused', 'withdrawn', 'expired', 'expired_unclaimed', 'rejected', 'not_created',
  'failed_by_amazon', 'failed_after_placement', 'cancelled',
]);
export type CreatorMcfSendState = z.infer<typeof CreatorMcfSendState>;

/** `held`: a sealed address exists in custody. `destroyed`: it never will again. */
export type CreatorMcfCustody = 'held' | 'destroyed';
export interface CreatorMcfSendTransition {
  readonly custody: CreatorMcfCustody;
  readonly next: readonly CreatorMcfSendState[];
}

const transition = (custody: CreatorMcfCustody, ...next: CreatorMcfSendState[]): CreatorMcfSendTransition =>
  Object.freeze({ custody, next: Object.freeze(next) });

/**
 * Every state, whether it holds custody, and the states it may move to. A
 * state with no exits is terminal. `dispatching` holds custody until the POST
 * outcome is recorded, in the same transaction that destroys it. The database
 * transition trigger enforces this same map.
 */
export const CREATOR_MCF_SEND_TRANSITIONS: Readonly<Record<CreatorMcfSendState, CreatorMcfSendTransition>> = Object.freeze({
  sealed: transition('held', 'previewing', 'withdrawn', 'expired'),
  previewing: transition('held', 'preview_ready', 'preview_refused', 'withdrawn', 'expired'),
  preview_ready: transition('held', 'approved', 'previewing', 'withdrawn', 'expired'),
  stale: transition('held', 'previewing', 'withdrawn', 'expired'),
  approved: transition('held', 'dispatching', 'stale', 'withdrawn', 'accepted', 'placed', 'conflict', 'failed_by_amazon',
    'expired_unclaimed', 'expired'),
  dispatching: transition('held', 'accepted', 'rejected', 'uncertain'),
  accepted: transition('destroyed', 'placed', 'failed_by_amazon', 'conflict'),
  uncertain: transition('destroyed', 'accepted', 'placed', 'failed_by_amazon', 'conflict', 'not_created'),
  conflict: transition('destroyed', 'placed', 'cancel_requested', 'failed_by_amazon'),
  placed: transition('destroyed', 'failed_after_placement', 'cancel_requested'),
  cancel_requested: transition('destroyed', 'cancel_dispatching', 'placed'),
  cancel_dispatching: transition('destroyed', 'cancelled', 'placed'),
  preview_refused: transition('destroyed'),
  withdrawn: transition('destroyed'),
  expired: transition('destroyed'),
  expired_unclaimed: transition('destroyed'),
  rejected: transition('destroyed'),
  not_created: transition('destroyed'),
  failed_by_amazon: transition('destroyed'),
  failed_after_placement: transition('destroyed'),
  cancelled: transition('destroyed'),
});

/** A send starts when the browser's envelope is stored. */
export const CREATOR_MCF_SEND_INITIAL_STATE: CreatorMcfSendState = 'sealed';

export function isCustodyHeldState(state: CreatorMcfSendState): boolean {
  return CREATOR_MCF_SEND_TRANSITIONS[state].custody === 'held';
}
export function isTerminalState(state: CreatorMcfSendState): boolean {
  return CREATOR_MCF_SEND_TRANSITIONS[state].next.length === 0;
}
export function canTransitionCreatorMcfSend(from: CreatorMcfSendState, to: CreatorMcfSendState): boolean {
  return CREATOR_MCF_SEND_TRANSITIONS[from].next.includes(to);
}

/** A flag on the send, not a state. WP-334's not-found escalation is read from the lane. */
export const CreatorMcfEscalation = z.enum(['ladder_exhausted', 'conflict']);
export type CreatorMcfEscalation = z.infer<typeof CreatorMcfEscalation>;

// ---------------------------------------------------------------------------
// Amazon's order status.
// ---------------------------------------------------------------------------

export const CreatorMcfOrderStatusClass = z.enum(['awaiting_validation', 'validated', 'failed']);
export type CreatorMcfOrderStatusClass = z.infer<typeof CreatorMcfOrderStatusClass>;
const ORDER_STATUS_CLASS: Readonly<Record<FulfillmentOrderStatus, CreatorMcfOrderStatusClass>> = Object.freeze({
  New: 'awaiting_validation',
  Received: 'validated', Planning: 'validated', Processing: 'validated', Complete: 'validated', CompletePartialled: 'validated',
  Invalid: 'failed', Unfulfillable: 'failed', Cancelled: 'failed',
});

/** The nine v2020-07-01 statuses in three classes. An unknown status throws rather than guessing. */
export function classifyMcfOrderStatus(status: FulfillmentOrderStatus): CreatorMcfOrderStatusClass {
  return ORDER_STATUS_CLASS[FulfillmentOrderStatus.parse(status)];
}

/** The model: "The seller can cancel" only Received and Planning; Processing cannot be cancelled. */
export const CreatorMcfCancellableStatus = z.enum(['Received', 'Planning']);
export type CreatorMcfCancellableStatus = z.infer<typeof CreatorMcfCancellableStatus>;

// ---------------------------------------------------------------------------
// The immutable, address-free preview.
// ---------------------------------------------------------------------------

/** How long an Amazon preview may be approved after it was read. */
export const CREATOR_MCF_PREVIEW_VALID_MS = 30 * 60 * 1000;
/** How old the getOrder read behind a cancel may be. */
export const CREATOR_MCF_CANCEL_PREVIEW_VALID_MS = 5 * 60 * 1000;
/** The sentence every send preview carries (clause 8: creation has no delete rollback). */
export const CREATOR_MCF_IRREVERSIBILITY =
  'Arcana cannot delete an Amazon order. It can ask Amazon to cancel only while the order is Received or Planning.';

export const CreatorMcfPreviewItem = z.object({
  sellerSku: SellerSku,
  /** The CCS key, a hyphen and the line number; at most 40 characters (the model's limit). */
  sellerFulfillmentOrderItemId: z.string().regex(/^CCS-[0-9a-f]{32}-[1-9][0-9]?$/, 'expected the order key and a line number'),
  quantity: Units,
}).strict();
export type CreatorMcfPreviewItem = z.infer<typeof CreatorMcfPreviewItem>;

/** Amazon's estimated fees in minor units. `feeName` is the model's FeeName code. */
export const CreatorMcfFees = z.object({
  parts: z.array(z.object({ feeName: ProviderCode, amountMinor: MinorAmount }).strict()).min(1).max(20),
  totalMinor: MinorAmount,
  currency: Currency,
}).strict().refine((fees) => fees.parts.reduce((sum, part) => sum + part.amountMinor, 0) === fees.totalMinor,
  { path: ['totalMinor'], message: 'the fee parts do not add up to the total' });
export type CreatorMcfFees = z.infer<typeof CreatorMcfFees>;

const previewIdentity = {
  previewId: Uuid,
  sendId: Uuid,
  derivedOrderKey: CreatorSampleOrderKey,
  reservationId: CreatorMcfReservationId,
  spapiConnectionId: Uuid,
  marketplaceId: MarketplaceId,
  readAt: Timestamp,
  validUntil: Timestamp,
  workerRevision: WorkerRevision,
};

const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;

function checkPreviewCommon(
  preview: { items: CreatorMcfPreviewItem[]; totalUnits: number; derivedOrderKey: string; readAt: string; validUntil: string },
  maxValidMs: number,
  ctx: z.RefinementCtx,
): void {
  // zod runs refinements after non-aborting issues too, so nothing here may assume a field passed its own check.
  if (preview.items.reduce((sum, item) => sum + item.quantity, 0) !== preview.totalUnits) {
    ctx.addIssue({ code: 'custom', path: ['totalUnits'], message: 'total units must equal the item quantities' });
  }
  const itemIds: unknown[] = preview.items.map((item) => item.sellerFulfillmentOrderItemId);
  if (!unique(itemIds) || itemIds.some((id) => typeof id !== 'string' || !id.startsWith(`${preview.derivedOrderKey}-`))) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'item ids must be distinct lines of this order key' });
  }
  const validFor = Date.parse(preview.validUntil) - Date.parse(preview.readAt);
  if (!(validFor > 0 && validFor <= maxValidMs)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validity must end after the read and within the allowed window' });
  }
}

/**
 * The `getFulfillmentPreview` answer for exactly the items and settings the
 * create will send, with the lane's identity, the caps it was checked against
 * and the envelope it was read with. `preview` is shown for approval;
 * `dispatch_reread` is read again just before the POST and compared.
 *
 * No field holds the mask or any recipient attribute, and every object is
 * strict, so a stray recipient key is refused at any depth.
 */
export const CreatorMcfSendPreview = z.object({
  ...previewIdentity,
  kind: z.enum(['preview', 'dispatch_reread']),
  preflightRunId: PreflightRunId,
  preflightCompletedAt: Timestamp,
  asin: CreatorAsin,
  items: z.array(CreatorMcfPreviewItem).min(1).max(CREATOR_MCF_MAX_UNITS),
  totalUnits: Units,
  shippingSpeedCategory: z.literal('Standard'),
  fulfillmentAction: z.literal('Ship'),
  fulfillmentPolicy: z.literal('FillOrKill'),
  featureConstraints: z.tuple([]),
  existingOrder: z.literal('none'),
  isFulfillable: z.boolean(),
  /** Null only when Amazon returned no estimate, which a fulfillable preview must have. */
  fees: CreatorMcfFees.nullable(),
  unfulfillableReasons: z.array(ProviderCode).max(20),
  earliestArrivalDate: z.iso.date().nullable(),
  latestArrivalDate: z.iso.date().nullable(),
  /** Null means the cap is missing, which refuses the send. */
  laneFeeCapMinor: MinorAmount.nullable(),
  grantFeeCapMinor: MinorAmount.nullable(),
  grantCurrency: Currency.nullable(),
  /** Hex SHA-256 of the envelope's decoded ciphertext bytes; the database's ciphertext_sha256. */
  envelopeSha256: Hex64,
  keyId: CreatorMcfKeyId,
  irreversibility: z.literal(CREATOR_MCF_IRREVERSIBILITY),
}).strict().superRefine((preview, ctx) => {
  checkPreviewCommon(preview, CREATOR_MCF_PREVIEW_VALID_MS, ctx);
  if (!unique(preview.unfulfillableReasons)) {
    ctx.addIssue({ code: 'custom', path: ['unfulfillableReasons'], message: 'a reason repeats' });
  }
  if (preview.isFulfillable && (preview.fees === null || preview.unfulfillableReasons.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['isFulfillable'], message: 'a fulfillable preview has fees and no unfulfillable reason' });
  }
  if (preview.earliestArrivalDate !== null && preview.latestArrivalDate !== null
    && preview.earliestArrivalDate > preview.latestArrivalDate) {
    ctx.addIssue({ code: 'custom', path: ['latestArrivalDate'], message: 'the arrival window is reversed' });
  }
});
export type CreatorMcfSendPreview = z.infer<typeof CreatorMcfSendPreview>;

/** The getOrder read behind a cancel: the order under the key, still Received or Planning. */
export const CreatorMcfCancelPreview = z.object({
  ...previewIdentity,
  kind: z.literal('cancel_preview'),
  existingOrder: z.object({ status: CreatorMcfCancellableStatus }).strict(),
  items: z.array(CreatorMcfPreviewItem).min(1).max(CREATOR_MCF_MAX_UNITS),
  totalUnits: Units,
}).strict().superRefine((preview, ctx) => { checkPreviewCommon(preview, CREATOR_MCF_CANCEL_PREVIEW_VALID_MS, ctx); });
export type CreatorMcfCancelPreview = z.infer<typeof CreatorMcfCancelPreview>;

export const CreatorMcfPreview = z.discriminatedUnion('kind', [CreatorMcfSendPreview, CreatorMcfCancelPreview]);
export type CreatorMcfPreview = z.infer<typeof CreatorMcfPreview>;

/** Hex SHA-256 of the preview's canonical JSON. The approval carries it; any change to any field changes it. */
export async function creatorMcfPreviewFingerprint(preview: CreatorMcfPreview): Promise<string> {
  const parsed = CreatorMcfPreview.parse(preview);
  return creatorMcfSha256Hex(new TextEncoder().encode(creatorMcfCanonicalJson(parsed)));
}

/** The comparison fields, at the granularity the preview card shows them. */
export const CreatorMcfPreviewField = z.enum([
  'kind', 'sendId', 'derivedOrderKey', 'reservationId', 'preflightRunId', 'preflightCompletedAt', 'asin', 'items', 'totalUnits',
  'shippingSpeedCategory', 'fulfillmentAction', 'fulfillmentPolicy', 'featureConstraints', 'existingOrder', 'isFulfillable',
  'fees', 'fees.parts', 'fees.totalMinor', 'fees.currency', 'unfulfillableReasons', 'earliestArrivalDate', 'latestArrivalDate',
  'laneFeeCapMinor', 'grantFeeCapMinor', 'grantCurrency', 'envelopeSha256', 'keyId', 'spapiConnectionId', 'marketplaceId',
]);
export type CreatorMcfPreviewField = z.infer<typeof CreatorMcfPreviewField>;

const sortedItems = (items: readonly CreatorMcfPreviewItem[]): string => creatorMcfCanonicalJson(
  [...items].sort((left, right) => (left.sellerFulfillmentOrderItemId < right.sellerFulfillmentOrderItemId ? -1 : 1)));
const sortedStrings = (values: readonly string[]): string => creatorMcfCanonicalJson([...values].sort());
const sortedFeeParts = (fees: CreatorMcfFees): string => creatorMcfCanonicalJson(
  fees.parts.map((part) => `${part.feeName}:${part.amountMinor}`).sort());

/**
 * The fields in which a re-read differs from the approved preview. Any entry
 * means stale: no POST. Ids and times of the read itself (previewId, kind
 * within one variant, readAt, validUntil, workerRevision) are not compared.
 * Order does not matter for items, fee parts or reasons.
 */
export function creatorMcfPreviewsDiffer(approved: CreatorMcfPreview, reread: CreatorMcfPreview): CreatorMcfPreviewField[] {
  const a = CreatorMcfPreview.parse(approved);
  const b = CreatorMcfPreview.parse(reread);
  if ((a.kind === 'cancel_preview') !== (b.kind === 'cancel_preview')) return ['kind'];
  const differs = new Set<CreatorMcfPreviewField>();
  const compare = (field: CreatorMcfPreviewField, left: unknown, right: unknown): void => {
    if (creatorMcfCanonicalJson(left) !== creatorMcfCanonicalJson(right)) differs.add(field);
  };
  compare('sendId', a.sendId, b.sendId);
  compare('derivedOrderKey', a.derivedOrderKey, b.derivedOrderKey);
  compare('reservationId', a.reservationId, b.reservationId);
  compare('spapiConnectionId', a.spapiConnectionId, b.spapiConnectionId);
  compare('marketplaceId', a.marketplaceId, b.marketplaceId);
  compare('totalUnits', a.totalUnits, b.totalUnits);
  if (sortedItems(a.items) !== sortedItems(b.items)) differs.add('items');
  if (a.kind === 'cancel_preview' && b.kind === 'cancel_preview') {
    compare('existingOrder', a.existingOrder, b.existingOrder);
  } else if (a.kind !== 'cancel_preview' && b.kind !== 'cancel_preview') {
    compare('preflightRunId', a.preflightRunId, b.preflightRunId);
    compare('preflightCompletedAt', a.preflightCompletedAt, b.preflightCompletedAt);
    compare('asin', a.asin, b.asin);
    compare('shippingSpeedCategory', a.shippingSpeedCategory, b.shippingSpeedCategory);
    compare('fulfillmentAction', a.fulfillmentAction, b.fulfillmentAction);
    compare('fulfillmentPolicy', a.fulfillmentPolicy, b.fulfillmentPolicy);
    compare('featureConstraints', a.featureConstraints, b.featureConstraints);
    compare('existingOrder', a.existingOrder, b.existingOrder);
    compare('isFulfillable', a.isFulfillable, b.isFulfillable);
    if ((a.fees === null) !== (b.fees === null)) differs.add('fees');
    else if (a.fees !== null && b.fees !== null) {
      if (sortedFeeParts(a.fees) !== sortedFeeParts(b.fees)) differs.add('fees.parts');
      compare('fees.totalMinor', a.fees.totalMinor, b.fees.totalMinor);
      compare('fees.currency', a.fees.currency, b.fees.currency);
    }
    if (sortedStrings(a.unfulfillableReasons) !== sortedStrings(b.unfulfillableReasons)) differs.add('unfulfillableReasons');
    compare('earliestArrivalDate', a.earliestArrivalDate, b.earliestArrivalDate);
    compare('latestArrivalDate', a.latestArrivalDate, b.latestArrivalDate);
    compare('laneFeeCapMinor', a.laneFeeCapMinor, b.laneFeeCapMinor);
    compare('grantFeeCapMinor', a.grantFeeCapMinor, b.grantFeeCapMinor);
    compare('grantCurrency', a.grantCurrency, b.grantCurrency);
    compare('envelopeSha256', a.envelopeSha256, b.envelopeSha256);
    compare('keyId', a.keyId, b.keyId);
  }
  return CreatorMcfPreviewField.options.filter((field) => differs.has(field));
}

// ---------------------------------------------------------------------------
// Confirmation wording and the approval.
// ---------------------------------------------------------------------------

function isCount(count: unknown): count is number {
  return Number.isInteger(count) && (count as number) >= 1 && (count as number) <= CREATOR_MCF_MAX_UNITS;
}

function assertCount(count: number): void {
  if (!isCount(count)) throw new RangeError(`the count must be an integer from 1 to ${CREATOR_MCF_MAX_UNITS}`);
}

/** The Send button's exact text (clause 4). The database recomputes and compares it. */
export function creatorMcfSendConfirmation(units: number): string {
  assertCount(units);
  return `Send ${units} unit${units === 1 ? '' : 's'} via Amazon`;
}

/** The cancel button's exact text. */
export function creatorMcfCancelConfirmation(orders: number): string {
  assertCount(orders);
  return `Cancel ${orders} order${orders === 1 ? '' : 's'} in Amazon`;
}

/** The press on "Send N unit(s) via Amazon": bound to one preview row by id and fingerprint. */
export const CreatorMcfSendApproval = z.object({
  sendId: Uuid,
  previewId: Uuid,
  previewFingerprint: Hex64,
  totalUnits: Units,
  confirmation: z.string().max(40),
  requestId: Uuid,
}).strict().refine((approval) => isCount(approval.totalUnits) && approval.confirmation === creatorMcfSendConfirmation(approval.totalUnits),
  { path: ['confirmation'], message: 'the confirmation must name Amazon and the exact unit count' });
export type CreatorMcfSendApproval = z.infer<typeof CreatorMcfSendApproval>;

/**
 * The `displayableOrderComment` on every sample order. Fixed, with no creator
 * data; it prints on recipient-facing material. Placeholder wording until
 * Victor decides it (DESIGN decision D8). The model allows 750 characters.
 */
export const CREATOR_MCF_PACKING_SLIP_COMMENT = 'Thank you for your order.';

// ---------------------------------------------------------------------------
// What Amazon answered to the create, as codes.
// ---------------------------------------------------------------------------

const ProviderCodes = z.array(ProviderCode).max(20).refine(unique, 'a code repeats');

/**
 * The create's outcome. No free text: a 4xx body keeps only `errors[].code`.
 * `uncertain` means the order may exist; it is settled by reads, never by a
 * second POST.
 */
export const CreatorMcfProviderOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), status: z.literal(200) }).strict(),
  z.object({
    outcome: z.literal('rejected'),
    status: z.number().int().min(400).max(499).refine((status) => status !== 408, '408 is uncertain, not rejected'),
    codes: ProviderCodes,
    reason: z.enum(['validation', 'authorization', 'throttled', 'other']),
  }).strict().refine((rejected) => (rejected.reason === 'throttled') === (rejected.status === 429)
    && (rejected.reason === 'authorization') === (rejected.status === 401 || rejected.status === 403),
  { path: ['reason'], message: 'the reason does not match the status' }),
  z.object({
    outcome: z.literal('uncertain'),
    cause: z.enum(['transport', 'http_5xx', 'http_408', 'decode', 'crash']),
    status: z.number().int().min(100).max(599).nullable(),
  }).strict().refine((uncertain) => {
    switch (uncertain.cause) {
      case 'transport': case 'crash': return uncertain.status === null;
      case 'http_5xx': return uncertain.status !== null && uncertain.status >= 500;
      case 'http_408': return uncertain.status === 408;
      case 'decode': return true;
    }
  }, { path: ['status'], message: 'the status does not match the cause' }),
]);
export type CreatorMcfProviderOutcome = z.infer<typeof CreatorMcfProviderOutcome>;

// ---------------------------------------------------------------------------
// Per-tick counts (clause 6).
// ---------------------------------------------------------------------------

const COUNT_KEYS = [
  'claimed', 'previewed', 'previewRefused', 'previewRefusedRecipient', 'stale', 'foundBeforePost', 'posted', 'deferred', 'expired',
  'accepted', 'rejected', 'uncertain', 'custodyDestroyed',
  'unitsRequested', 'unitsAccepted', 'unitsRejected', 'unitsUncertain', 'unitsStale', 'unitsFoundBeforePost', 'unitsDeferred',
  'unitsExpired', 'readThrottled',
] as const;
type CountKey = (typeof COUNT_KEYS)[number];
type Counts = Record<CountKey, number>;

/** Each invariant by name, so a failure says which one broke. */
const COUNT_INVARIANTS: readonly (readonly [string, (counts: Counts) => boolean])[] = [
  ['claimed = previewed + previewRefused + stale + foundBeforePost + posted + deferred + expired',
    (c) => c.claimed === c.previewed + c.previewRefused + c.stale + c.foundBeforePost + c.posted + c.deferred + c.expired],
  ['posted = accepted + rejected + uncertain', (c) => c.posted === c.accepted + c.rejected + c.uncertain],
  ['previewRefusedRecipient <= previewRefused', (c) => c.previewRefusedRecipient <= c.previewRefused],
  ['custodyDestroyed >= previewRefusedRecipient + foundBeforePost + posted + expired',
    (c) => c.custodyDestroyed >= c.previewRefusedRecipient + c.foundBeforePost + c.posted + c.expired],
  ['unitsRequested = unitsAccepted + unitsRejected + unitsUncertain + unitsStale + unitsFoundBeforePost + unitsDeferred + unitsExpired',
    (c) => c.unitsRequested === c.unitsAccepted + c.unitsRejected + c.unitsUncertain + c.unitsStale + c.unitsFoundBeforePost
      + c.unitsDeferred + c.unitsExpired],
];

/**
 * One worker tick. `readThrottled` counts read 429s and sits outside the
 * identities. Units are those of dispatch claims.
 */
export const CreatorMcfSendCounts = z.object(
  Object.fromEntries(COUNT_KEYS.map((key) => [key, Count])) as Record<CountKey, typeof Count>,
).strict().superRefine((counts, ctx) => {
  for (const [name, holds] of COUNT_INVARIANTS) {
    if (!holds(counts)) ctx.addIssue({ code: 'custom', path: [], message: name });
  }
});
export type CreatorMcfSendCounts = z.infer<typeof CreatorMcfSendCounts>;

/** Throws, naming each broken invariant, unless the counts reconcile. */
export function assertCreatorMcfCounts(counts: unknown): asserts counts is CreatorMcfSendCounts {
  const result = CreatorMcfSendCounts.safeParse(counts);
  if (!result.success) {
    const broken = result.error.issues.map((issue) => (issue.code === 'custom' ? issue.message : `${issue.path.join('.') || 'counts'}: ${issue.code}`));
    throw new Error(`creator MCF counts do not reconcile: ${broken.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// The MCP read: creators.sample_send_outcome.
// ---------------------------------------------------------------------------

/**
 * What a skill may act on. `placed` is the only class on which it records the
 * order; `failed` and `cancelled` mean no active order; `pending` and
 * `uncertain` mean wait (uncertain covers an unknown POST outcome, a conflict
 * and a cancel in flight).
 */
export const CreatorMcfSendOutcomeClass = z.enum(['pending', 'placed', 'failed', 'uncertain', 'cancelled']);
export type CreatorMcfSendOutcomeClass = z.infer<typeof CreatorMcfSendOutcomeClass>;
const OUTCOME_CLASS: Readonly<Record<CreatorMcfSendState, CreatorMcfSendOutcomeClass>> = Object.freeze({
  sealed: 'pending', previewing: 'pending', preview_ready: 'pending', stale: 'pending', approved: 'pending',
  dispatching: 'pending', accepted: 'pending',
  placed: 'placed',
  uncertain: 'uncertain', conflict: 'uncertain', cancel_requested: 'uncertain', cancel_dispatching: 'uncertain',
  preview_refused: 'failed', withdrawn: 'failed', expired: 'failed', expired_unclaimed: 'failed', rejected: 'failed',
  not_created: 'failed', failed_by_amazon: 'failed', failed_after_placement: 'failed',
  cancelled: 'cancelled',
});
export function creatorMcfSendOutcomeClass(state: CreatorMcfSendState): CreatorMcfSendOutcomeClass {
  return OUTCOME_CLASS[state];
}

/** No mask, no address, no fee: the key, the state and what Amazon said. */
export const CreatorMcfSendOutcome = z.object({
  derivedOrderKey: CreatorSampleOrderKey,
  state: CreatorMcfSendState,
  class: CreatorMcfSendOutcomeClass,
  escalated: z.boolean(),
  mcfStatus: FulfillmentOrderStatus.nullable(),
  acceptedAt: Timestamp.nullable(),
  placedAt: Timestamp.nullable(),
  reservationId: CreatorMcfReservationId,
}).strict().superRefine((outcome, ctx) => {
  if (outcome.class !== creatorMcfSendOutcomeClass(outcome.state)) {
    ctx.addIssue({ code: 'custom', path: ['class'], message: 'the class does not match the state' });
  }
  if (outcome.state === 'placed' && outcome.placedAt === null) {
    ctx.addIssue({ code: 'custom', path: ['placedAt'], message: 'a placed send has a placement time' });
  }
});
export type CreatorMcfSendOutcome = z.infer<typeof CreatorMcfSendOutcome>;
