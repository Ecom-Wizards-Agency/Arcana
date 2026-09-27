/**
 * The sealed recipient envelope for Arcana's MCF sample sends (WP-338).
 *
 * RFC 9180 HPKE, mode_base, with one pinned suite (Appendix A.3):
 * DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. The browser seals the
 * address to the MCF worker's public key; only the worker, which holds the
 * private key, can open it. One message per context, so the only sequence
 * number used is 0. The secret-export interface is not used.
 *
 * WebCrypto only (`globalThis.crypto.subtle`): ECDH P-256 `deriveBits` for DH,
 * HMAC-SHA256 for LabeledExtract and LabeledExpand, AES-GCM for the AEAD. The
 * same code runs in browsers and in Node.
 *
 * Every failure is a `CreatorMcfEnvelopeError` whose message is one fixed code
 * and nothing else: the worker persists `error.message`, so no key, plaintext,
 * ciphertext or input value may ever reach it. Underlying errors are dropped,
 * not attached as a cause.
 */
import { z } from 'zod';
import {
  CREATOR_MCF_CIPHERTEXT_MAX_BYTES, CREATOR_MCF_ENC_BYTES, CREATOR_MCF_ENVELOPE_SUITE, CreatorMcfKeyId, CreatorMcfRecipient,
  CreatorMcfRecipientBinding, CreatorMcfRecipientPublicJwk, CreatorMcfSealedRecipient, creatorMcfBase64UrlDecode,
  creatorMcfBase64UrlEncode, creatorMcfCanonicalJson, creatorMcfMask, creatorMcfRecipientAad, creatorMcfRecipientIssues,
  creatorMcfSha256Hex,
} from './mcf-send.js';
import type { CreatorMcfMask, CreatorMcfRecipientIssue } from './mcf-send.js';

type Bytes = Uint8Array<ArrayBuffer>;
type Subtle = typeof globalThis.crypto.subtle;
type WebCryptoKey = Awaited<ReturnType<Subtle['importKey']>>;

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * `envelope_invalid`: an input is out of shape (envelope, binding, recipient).
 * `key_mismatch`: a key is malformed, is not the key its id names, or its two
 * halves do not belong together. `envelope_unopenable`: a cryptographic step
 * failed, on seal or on open (tampering, the wrong key pair, or no WebCrypto).
 */
export const CreatorMcfEnvelopeErrorCode = z.enum(['envelope_invalid', 'envelope_unopenable', 'key_mismatch']);
export type CreatorMcfEnvelopeErrorCode = z.infer<typeof CreatorMcfEnvelopeErrorCode>;

export class CreatorMcfEnvelopeError extends Error {
  readonly code: CreatorMcfEnvelopeErrorCode;
  constructor(code: CreatorMcfEnvelopeErrorCode) {
    super(code);
    this.name = 'CreatorMcfEnvelopeError';
    this.code = code;
  }
}

function fail(code: CreatorMcfEnvelopeErrorCode): never {
  throw new CreatorMcfEnvelopeError(code);
}

/**
 * Parses an input or fails with `code`. A getter or Proxy that throws during
 * the parse is an input problem too, so it gets the same code.
 */
function parseOr<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown,
  code: CreatorMcfEnvelopeErrorCode): T {
  let result: { success: true; data: T } | { success: false };
  try {
    result = schema.safeParse(value);
  } catch {
    fail(code);
  }
  if (!result.success) fail(code);
  return result.data;
}

/** Runs `work`; any error that is not already a fixed-code error becomes `fallback`, with nothing carried over. */
async function guarded<T>(fallback: CreatorMcfEnvelopeErrorCode, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CreatorMcfEnvelopeError) throw new CreatorMcfEnvelopeError(error.code);
    throw new CreatorMcfEnvelopeError(fallback);
  }
}

// ---------------------------------------------------------------------------
// Suite constants and byte helpers (RFC 9180 sections 4, 5.1 and 7.1).
// ---------------------------------------------------------------------------

/** The pinned suite identifiers: mode_base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. */
export const CREATOR_MCF_HPKE_SUITE = Object.freeze({ mode: 0x00, kemId: 0x0010, kdfId: 0x0001, aeadId: 0x0001 });
/** The HPKE `info` for every recipient envelope. */
export const CREATOR_MCF_HPKE_INFO = 'arcana.creator-mcf-recipient.v1';

/** RFC 9180 Table 2 and 5: Nsecret, Npk (= Nenc), Ndh for P-256; Nh for SHA-256; Nk, Nn, Nt for AES-128-GCM. */
const N_SECRET = 32;
const N_DH = 32;
const N_H = 32;
const N_K = 16;
const N_N = 12;
const N_T = 16;

const EMPTY: Bytes = new Uint8Array(0);

function ascii(text: string): Bytes {
  return new TextEncoder().encode(text);
}

function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** I2OSP(n, w): n as a w-byte big-endian string. */
function i2osp(value: number, width: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (8 * width)) throw new RangeError('I2OSP out of range');
  const out = new Uint8Array(width);
  let rest = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    out[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function zero(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function subtle(): Subtle {
  const api = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (api === undefined) fail('envelope_unopenable');
  return api;
}

function randomUuid(): string {
  const api = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (api === undefined || typeof api.randomUUID !== 'function') fail('envelope_unopenable');
  return api.randomUUID();
}

/** Whether this runtime can seal: WebCrypto (a secure context in browsers) and randomUUID. */
export function creatorMcfEnvelopeSupported(): boolean {
  const api = (globalThis as { crypto?: { subtle?: unknown; randomUUID?: unknown } }).crypto;
  return api !== undefined && typeof api.subtle === 'object' && api.subtle !== null && typeof api.randomUUID === 'function';
}

/** suite_id for the KEM (section 4.1): "KEM" || I2OSP(kem_id, 2). */
const KEM_SUITE_ID = concat(ascii('KEM'), i2osp(CREATOR_MCF_HPKE_SUITE.kemId, 2));
/** suite_id for the key schedule (section 5.1): "HPKE" || kem_id || kdf_id || aead_id. */
const HPKE_SUITE_ID = concat(ascii('HPKE'), i2osp(CREATOR_MCF_HPKE_SUITE.kemId, 2), i2osp(CREATOR_MCF_HPKE_SUITE.kdfId, 2),
  i2osp(CREATOR_MCF_HPKE_SUITE.aeadId, 2));
const HPKE_VERSION = ascii('HPKE-v1');
/** DER prefix of a P-256 SubjectPublicKeyInfo holding an uncompressed point (id-ecPublicKey, prime256v1). */
const P256_SPKI_PREFIX = Uint8Array.of(0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00);

// ---------------------------------------------------------------------------
// HKDF-SHA256 over HMAC (RFC 5869) and the labeled forms (RFC 9180 section 4).
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256. WebCrypto refuses a zero-length HMAC key, and RFC 5869 section
 * 2.2 replaces an absent salt with HashLen zero bytes. HMAC pads every key
 * shorter than the 64-byte block with zeros, so both are the same key.
 */
async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const hmacKey = await subtle().importKey('raw', key.length === 0 ? new Uint8Array(N_H) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', hmacKey, data));
}

/** Extract(salt, ikm). */
async function extract(salt: Bytes, ikm: Bytes): Promise<Bytes> {
  return hmac(salt, ikm);
}

/** Expand(prk, info, L). */
async function expand(prk: Bytes, info: Bytes, length: number): Promise<Bytes> {
  if (length > 255 * N_H) throw new RangeError('HKDF-Expand length too large');
  const out = new Uint8Array(length);
  let block: Bytes = EMPTY;
  for (let counter = 1, offset = 0; offset < length; counter += 1) {
    const input = concat(block, info, Uint8Array.of(counter));
    zero(block);
    block = await hmac(prk, input);
    zero(input);
    const take = Math.min(block.length, length - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
  }
  zero(block);
  return out;
}

/** LabeledExtract(salt, label, ikm) = Extract(salt, "HPKE-v1" || suite_id || label || ikm). */
async function labeledExtract(suiteId: Bytes, salt: Bytes, label: string, ikm: Bytes): Promise<Bytes> {
  const labeledIkm = concat(HPKE_VERSION, suiteId, ascii(label), ikm);
  try {
    return await extract(salt, labeledIkm);
  } finally {
    zero(labeledIkm);
  }
}

/** LabeledExpand(prk, label, info, L) = Expand(prk, I2OSP(L, 2) || "HPKE-v1" || suite_id || label || info, L). */
async function labeledExpand(suiteId: Bytes, prk: Bytes, label: string, info: Bytes, length: number): Promise<Bytes> {
  return expand(prk, concat(i2osp(length, 2), HPKE_VERSION, suiteId, ascii(label), info), length);
}

// ---------------------------------------------------------------------------
// DHKEM(P-256, HKDF-SHA256) (section 4.1).
// ---------------------------------------------------------------------------

/** DeserializePublicKey: exactly 65 bytes, 0x04 || x || y; WebCrypto refuses a point that is not on the curve. */
async function importPoint(point: Bytes): Promise<WebCryptoKey> {
  if (point.length !== CREATOR_MCF_ENC_BYTES || point[0] !== 0x04) throw new RangeError('not an uncompressed P-256 point');
  return subtle().importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** DH(sk, pk): the 32-byte x-coordinate of the shared point. */
async function diffieHellman(privateKey: WebCryptoKey, publicKey: WebCryptoKey): Promise<Bytes> {
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 8 * N_DH));
  if (bits.length !== N_DH) throw new RangeError('unexpected DH length');
  return bits;
}

/** ExtractAndExpand(dh, kem_context). */
async function extractAndExpand(dh: Bytes, kemContext: Bytes): Promise<Bytes> {
  const eaePrk = await labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh);
  try {
    return await labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, N_SECRET);
  } finally {
    zero(eaePrk);
  }
}

/** An ephemeral ECDH P-256 key pair, as WebCrypto returns it. */
interface EphemeralKeyPair {
  readonly privateKey: WebCryptoKey;
  readonly publicKey: WebCryptoKey;
}

/** GenerateKeyPair(): the private half is non-extractable; WebCrypto always lets the public half be exported. */
async function generateEphemeral(): Promise<EphemeralKeyPair> {
  return subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/**
 * Encap(pkR), given pkR imported and serialized. enc = SerializePublicKey(pkE)
 * is computed here from the pair's public key on every path; `ephemeral`
 * replaces GenerateKeyPair only through the test seam.
 */
async function encap(recipientPublic: WebCryptoKey, pkRm: Bytes, ephemeral?: EphemeralKeyPair): Promise<{ sharedSecret: Bytes; enc: Bytes }> {
  const pair = ephemeral ?? await generateEphemeral();
  const enc = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  if (enc.length !== CREATOR_MCF_ENC_BYTES || enc[0] !== 0x04) throw new RangeError('not an uncompressed P-256 point');
  const dh = await diffieHellman(pair.privateKey, recipientPublic);
  try {
    return { sharedSecret: await extractAndExpand(dh, concat(enc, pkRm)), enc };
  } finally {
    zero(dh);
  }
}

/** Decap(enc, skR), with pkRm = SerializePublicKey(pk(skR)) supplied by the imported key pair. */
async function decap(enc: Bytes, privateKey: WebCryptoKey, pkRm: Bytes): Promise<Bytes> {
  const ephemeralPublic = await importPoint(enc);
  const dh = await diffieHellman(privateKey, ephemeralPublic);
  try {
    return await extractAndExpand(dh, concat(enc, pkRm));
  } finally {
    zero(dh);
  }
}

// ---------------------------------------------------------------------------
// Key schedule (section 5.1) and the AEAD (section 5.2), mode_base only.
// ---------------------------------------------------------------------------

interface KeySchedule {
  keyScheduleContext: Bytes;
  secret: Bytes;
  key: Bytes;
  baseNonce: Bytes;
}

/** KeySchedule(mode_base, shared_secret, info, default_psk = "", default_psk_id = ""). */
async function keyScheduleBase(sharedSecret: Bytes, info: Bytes): Promise<KeySchedule> {
  const pskIdHash = await labeledExtract(HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = await labeledExtract(HPKE_SUITE_ID, EMPTY, 'info_hash', info);
  const keyScheduleContext = concat(Uint8Array.of(CREATOR_MCF_HPKE_SUITE.mode), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY);
  const key = await labeledExpand(HPKE_SUITE_ID, secret, 'key', keyScheduleContext, N_K);
  const baseNonce = await labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', keyScheduleContext, N_N);
  return { keyScheduleContext, secret, key, baseNonce };
}

/** ComputeNonce(seq) = base_nonce XOR I2OSP(seq, Nn). Only seq = 0 is used; one message per context. */
function computeNonce(baseNonce: Uint8Array, sequence: number): Bytes {
  const sequenceBytes = i2osp(sequence, N_N);
  const nonce = new Uint8Array(baseNonce);
  if (nonce.length !== N_N) throw new RangeError('unexpected nonce length');
  for (let index = 0; index < N_N; index += 1) nonce[index] = (nonce[index] ?? 0) ^ (sequenceBytes[index] ?? 0);
  return nonce;
}

async function aeadSeal(key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes): Promise<Bytes> {
  const aesKey = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 8 * N_T }, aesKey, plaintext));
}

async function aeadOpen(key: Bytes, nonce: Bytes, aad: Bytes, ciphertext: Bytes): Promise<Bytes> {
  const aesKey = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 8 * N_T }, aesKey, ciphertext));
}

// ---------------------------------------------------------------------------
// Keys.
// ---------------------------------------------------------------------------

/** 0x04 || x || y from a validated public JWK. */
function jwkPoint(jwk: CreatorMcfRecipientPublicJwk): Bytes {
  const x = creatorMcfBase64UrlDecode(jwk.x);
  const y = creatorMcfBase64UrlDecode(jwk.y);
  if (x === null || y === null || x.length !== 32 || y.length !== 32) throw new RangeError('bad coordinate');
  return concat(Uint8Array.of(0x04), x, y);
}

async function keyIdForPoint(point: Bytes): Promise<string> {
  return creatorMcfSha256Hex(concat(P256_SPKI_PREFIX, point));
}

/** The key id of a recipient public JWK: hex SHA-256 of its SPKI DER. Throws `key_mismatch` for a malformed key. */
export async function creatorMcfRecipientKeyId(publicJwk: unknown): Promise<string> {
  return guarded('key_mismatch', async () => {
    const point = jwkPoint(parseOr(CreatorMcfRecipientPublicJwk, publicJwk, 'key_mismatch'));
    await importPoint(point);
    return keyIdForPoint(point);
  });
}

declare const recipientKeyBrand: unique symbol;
/**
 * An imported recipient key pair. Opaque: only `importCreatorMcfRecipientKey`
 * makes one, and the private half is a non-extractable CryptoKey held inside
 * this module.
 */
export interface CreatorMcfRecipientKey {
  readonly keyId: string;
  readonly [recipientKeyBrand]: true;
}
const recipientKeys = new WeakMap<CreatorMcfRecipientKey, { readonly privateKey: WebCryptoKey; readonly publicPoint: Bytes }>();

/**
 * Imports the worker's P-256 private key (PKCS#8 DER) as a non-extractable
 * ECDH key, with its public JWK. The public half supplies pkRm for Decap and
 * the key id; the pair is proven to belong together with one ECDH against a
 * fresh probe key. The caller should zero `pkcs8` afterwards; this function
 * zeroes its own copy. Throws `key_mismatch`.
 */
export async function importCreatorMcfRecipientKey(pkcs8: Uint8Array, publicJwk: unknown): Promise<CreatorMcfRecipientKey> {
  return guarded('key_mismatch', async () => {
    if (!(pkcs8 instanceof Uint8Array)) fail('key_mismatch');
    const publicPoint = jwkPoint(parseOr(CreatorMcfRecipientPublicJwk, publicJwk, 'key_mismatch'));
    const publicKey = await importPoint(publicPoint);
    const der: Bytes = new Uint8Array(pkcs8);
    let privateKey: WebCryptoKey;
    try {
      privateKey = await subtle().importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    } finally {
      zero(der);
    }
    const probe = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const fromPublic = await diffieHellman(probe.privateKey, publicKey);
    const fromPrivate = await diffieHellman(privateKey, probe.publicKey);
    const paired = equalBytes(fromPublic, fromPrivate);
    zero(fromPublic, fromPrivate);
    if (!paired) fail('key_mismatch');
    const handle = Object.freeze({ keyId: await keyIdForPoint(publicPoint) }) as CreatorMcfRecipientKey;
    recipientKeys.set(handle, Object.freeze({ privateKey, publicPoint }));
    return handle;
  });
}

// ---------------------------------------------------------------------------
// Seal and open.
// ---------------------------------------------------------------------------

async function sealWith(
  publicJwk: unknown,
  keyId: string,
  binding: CreatorMcfRecipientBinding,
  recipient: CreatorMcfRecipient,
  ephemeral: EphemeralKeyPair | undefined,
  envelopeId: string | undefined,
): Promise<CreatorMcfSealedRecipient> {
  return guarded('envelope_unopenable', async () => {
    const lane = parseOr(CreatorMcfRecipientBinding, binding, 'envelope_invalid');
    const address = parseOr(CreatorMcfRecipient, recipient, 'envelope_invalid');
    const pkRm = jwkPoint(parseOr(CreatorMcfRecipientPublicJwk, publicJwk, 'key_mismatch'));
    parseOr(CreatorMcfKeyId, keyId, 'key_mismatch');
    if (await keyIdForPoint(pkRm) !== keyId) fail('key_mismatch');
    let recipientPublic: WebCryptoKey;
    try {
      recipientPublic = await importPoint(pkRm);
    } catch {
      fail('key_mismatch');
    }
    const mask = creatorMcfMask(address);
    const id = envelopeId ?? randomUuid();
    let aad: Bytes;
    try {
      aad = creatorMcfRecipientAad({ ...lane, envelopeId: id, keyId, mask });
    } catch {
      fail('envelope_invalid');
    }
    const plaintext = new TextEncoder().encode(creatorMcfCanonicalJson(address));
    let sharedSecret: Bytes | undefined;
    let schedule: KeySchedule | undefined;
    let enc: Bytes;
    let ciphertext: Bytes;
    try {
      ({ sharedSecret, enc } = await encap(recipientPublic, pkRm, ephemeral));
      schedule = await keyScheduleBase(sharedSecret, ascii(CREATOR_MCF_HPKE_INFO));
      ciphertext = await aeadSeal(schedule.key, computeNonce(schedule.baseNonce, 0), aad, plaintext);
    } finally {
      zero(plaintext, sharedSecret, schedule?.secret, schedule?.key, schedule?.baseNonce);
    }
    if (ciphertext.length > CREATOR_MCF_CIPHERTEXT_MAX_BYTES) fail('envelope_invalid');
    const sealed = CreatorMcfSealedRecipient.safeParse({
      v: 1, suite: CREATOR_MCF_ENVELOPE_SUITE, envelopeId: id, keyId,
      enc: creatorMcfBase64UrlEncode(enc), ciphertext: creatorMcfBase64UrlEncode(ciphertext), mask,
    });
    if (!sealed.success) fail('envelope_invalid');
    return sealed.data;
  });
}

/**
 * Seals a recipient to the worker's public key for one lane. `keyId` must be
 * the id of `publicJwk` (an envelope sealed to a swapped key is refused before
 * anything is stored). The envelope id is a fresh uuid; the mask is computed
 * here and bound into the associated data with the lane, the envelope id and
 * the key id.
 */
export async function sealCreatorMcfRecipient(
  publicJwk: unknown,
  keyId: string,
  binding: CreatorMcfRecipientBinding,
  recipient: CreatorMcfRecipient,
): Promise<CreatorMcfSealedRecipient> {
  return sealWith(publicJwk, keyId, binding, recipient, undefined, undefined);
}

/**
 * What opening an authenticated envelope found. `recipient_invalid` and
 * `mask_mismatch` mean the sealer produced something Arcana refuses; both end
 * the send as preview_refused. Issues carry field names and rule codes only.
 */
export type CreatorMcfOpenResult =
  | { readonly status: 'opened'; readonly recipient: CreatorMcfRecipient; readonly mask: CreatorMcfMask }
  | { readonly status: 'recipient_invalid'; readonly issues: readonly CreatorMcfRecipientIssue[] }
  | { readonly status: 'mask_mismatch' };

/**
 * Opens an envelope in memory for the lane in `binding`. Throws
 * `envelope_invalid` for an out-of-shape envelope or binding, `key_mismatch`
 * when the envelope names another key, and `envelope_unopenable` when any
 * associated-data field, `enc` or the ciphertext was changed.
 */
export async function openCreatorMcfRecipient(
  key: CreatorMcfRecipientKey,
  envelope: unknown,
  binding: CreatorMcfRecipientBinding,
): Promise<CreatorMcfOpenResult> {
  return guarded('envelope_unopenable', async () => {
    const material = recipientKeys.get(key);
    if (material === undefined) fail('key_mismatch');
    const sealed = parseOr(CreatorMcfSealedRecipient, envelope, 'envelope_invalid');
    const lane = parseOr(CreatorMcfRecipientBinding, binding, 'envelope_invalid');
    if (sealed.keyId !== key.keyId) fail('key_mismatch');
    const enc = creatorMcfBase64UrlDecode(sealed.enc);
    const ciphertext = creatorMcfBase64UrlDecode(sealed.ciphertext);
    if (enc === null || ciphertext === null) fail('envelope_invalid');
    let aad: Bytes;
    try {
      aad = creatorMcfRecipientAad({ ...lane, envelopeId: sealed.envelopeId, keyId: sealed.keyId, mask: sealed.mask });
    } catch {
      fail('envelope_invalid');
    }
    let sharedSecret: Bytes | undefined;
    let schedule: KeySchedule | undefined;
    let plaintext: Bytes;
    try {
      sharedSecret = await decap(enc, material.privateKey, material.publicPoint);
      schedule = await keyScheduleBase(sharedSecret, ascii(CREATOR_MCF_HPKE_INFO));
      plaintext = await aeadOpen(schedule.key, computeNonce(schedule.baseNonce, 0), aad, ciphertext);
    } catch {
      fail('envelope_unopenable');
    } finally {
      zero(sharedSecret, schedule?.secret, schedule?.key, schedule?.baseNonce);
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch {
      return { status: 'recipient_invalid', issues: [{ field: null, rule: 'malformed' }] } as const;
    } finally {
      zero(plaintext);
    }
    const issues = creatorMcfRecipientIssues(candidate);
    const recipient = CreatorMcfRecipient.safeParse(candidate);
    if (issues.length > 0 || !recipient.success) {
      return { status: 'recipient_invalid', issues: issues.length > 0 ? issues : [{ field: null, rule: 'malformed' }] } as const;
    }
    const mask = creatorMcfMask(recipient.data);
    if (creatorMcfCanonicalJson(mask) !== creatorMcfCanonicalJson(sealed.mask)) return { status: 'mask_mismatch' } as const;
    return { status: 'opened', recipient: recipient.data, mask } as const;
  });
}

/** Hex SHA-256 of the envelope's decoded ciphertext: the preview's envelopeSha256 and the database's ciphertext_sha256. */
export async function creatorMcfEnvelopeSha256(envelope: unknown): Promise<string> {
  return guarded('envelope_invalid', async () => {
    const sealed = parseOr(CreatorMcfSealedRecipient, envelope, 'envelope_invalid');
    const ciphertext = creatorMcfBase64UrlDecode(sealed.ciphertext);
    if (ciphertext === null) fail('envelope_invalid');
    return creatorMcfSha256Hex(ciphertext);
  });
}

// ---------------------------------------------------------------------------
// Test seam. Not re-exported from the package root (see registry.ts).
// ---------------------------------------------------------------------------

/**
 * @internal For tests only: the RFC 9180 steps with the ephemeral key
 * injected, so the Appendix A.3 vector can be reproduced byte for byte. The
 * package root does not export this; application code must not import it.
 */
export const creatorMcfHpkeTestSeam = Object.freeze({
  /** SetupBaseS(pkR, info) with Encap's GenerateKeyPair replaced by `ephemeral`. */
  async setupBaseSender(pkRm: Bytes, info: Bytes, ephemeral: EphemeralKeyPair) {
    const { sharedSecret, enc } = await encap(await importPoint(pkRm), pkRm, ephemeral);
    return { enc, sharedSecret, ...(await keyScheduleBase(sharedSecret, info)) };
  },
  /** SetupBaseR(enc, skR, info) with an imported recipient key. */
  async setupBaseRecipient(enc: Bytes, key: CreatorMcfRecipientKey, info: Bytes) {
    const material = recipientKeys.get(key);
    if (material === undefined) fail('key_mismatch');
    const sharedSecret = await decap(enc, material.privateKey, material.publicPoint);
    return { sharedSecret, ...(await keyScheduleBase(sharedSecret, info)) };
  },
  computeNonce,
  aeadSeal,
  aeadOpen,
  /** sealCreatorMcfRecipient with a fixed ephemeral key and envelope id, for a deterministic envelope. */
  sealWithEphemeral(
    publicJwk: unknown, keyId: string, binding: CreatorMcfRecipientBinding, recipient: CreatorMcfRecipient,
    ephemeral: EphemeralKeyPair, envelopeId: string,
  ): Promise<CreatorMcfSealedRecipient> {
    return sealWith(publicJwk, keyId, binding, recipient, ephemeral, envelopeId);
  },
});
