/**
 * Opening a sealed recipient in the MCF unit's memory (WP-338e; DESIGN 4.3).
 *
 * The private key lives only in the unit's systemd credentials directory
 * (`LoadCredentialEncrypted=`), one file per key named
 * `mcf-recipient-<first 8 hex of the key id>`, holding the P-256 PKCS#8 DER
 * bytes. It is never read from the environment.
 *
 * Key handling (the WP-338a amendment's open question): per-open import. Every
 * open reads the file again, derives the public JWK from it with
 * node:crypto (WebCrypto cannot derive it from a non-extractable key), imports
 * the pair through `importCreatorMcfRecipientKey` as a non-extractable key,
 * zeroes the file bytes, and drops the handle after the open. Nothing is
 * cached, so rotating or destroying a credential file takes effect at the next
 * open, and at 20 units a day the import cost is negligible.
 *
 * Before anything is decrypted the custody read must match the claim (send
 * binding, envelope id, key id, ciphertext digest and mask), and the mask's
 * country must belong to the send's marketplace, which the ledger cannot check.
 * After opening, the recipient is validated again and its mask recomputed.
 *
 * Every refusal is a fixed code; no error, result or log carries a recipient
 * value. The opened recipient is returned to the caller in memory only.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CreatorMcfEnvelopeError, creatorMcfCanonicalJson, creatorMcfEnvelopeSha256, creatorMcfMask, importCreatorMcfRecipientKey, openCreatorMcfRecipient,
  type CreatorMcfMask, type CreatorMcfOpenResult, type CreatorMcfRecipient, type CreatorMcfRecipientBinding, type CreatorMcfRecipientKey,
  type CreatorMcfSealedRecipient,
} from '@wizard-ads/shared';
import { marketplaceIdForCountry } from '../marketplaces.js';

/** Credential file names: this prefix and the first 8 hex characters of the key id. */
export const MCF_RECIPIENT_CREDENTIAL_PREFIX = 'mcf-recipient-';
const CREDENTIAL_NAME = /^mcf-recipient-[0-9a-f]{8}$/;
const KEY_ID = /^[0-9a-f]{64}$/;
/** A P-256 PKCS#8 DER key is about 138 bytes; anything larger is not one. */
const MAX_KEY_FILE_BYTES = 4096;
/** The codes the ledger keeps (`^[A-Za-z0-9_.]{1,64}$`), at most 20. */
const MAX_CODES = 20;

export function mcfRecipientCredentialName(keyId: string): string {
  return `${MCF_RECIPIENT_CREDENTIAL_PREFIX}${keyId.slice(0, 8)}`;
}

export type McfCustodyErrorCode = 'key_unavailable' | 'key_mismatch';

/** A key problem. The message is the code and nothing else. */
export class McfCustodyError extends Error {
  constructor(readonly code: McfCustodyErrorCode) {
    super(code);
    this.name = 'McfCustodyError';
  }
}

/** Reads a recipient key from its source at each call; nothing is cached. */
export interface McfRecipientKeySource {
  load(keyId: string): Promise<CreatorMcfRecipientKey>;
  /** The key ids of every readable key, each proven to import and to match its file name. Throws on any bad file. */
  inventory(): Promise<string[]>;
}

/** The two file reads the key source needs; tests count them. */
export interface McfKeyFiles {
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
}

const nodeKeyFiles: McfKeyFiles = {
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path),
};

/** Imports one PKCS#8 DER key and zeroes the bytes, whatever happens. */
async function importKeyFile(bytes: Uint8Array): Promise<CreatorMcfRecipientKey> {
  try {
    // DER starts with a SEQUENCE tag; a PEM file or anything else is refused.
    if (bytes.length === 0 || bytes.length > MAX_KEY_FILE_BYTES || bytes[0] !== 0x30) throw new McfCustodyError('key_unavailable');
    let publicJwk: Record<string, unknown>;
    try {
      const der = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // The public half only: the transient private KeyObject is dropped at once and never exported.
      const exported = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
      if (exported.kty !== 'EC' || exported.crv !== 'P-256') throw new Error('not P-256');
      publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
    } catch {
      throw new McfCustodyError('key_unavailable');
    }
    try {
      return await importCreatorMcfRecipientKey(bytes, publicJwk);
    } catch {
      throw new McfCustodyError('key_mismatch');
    }
  } finally {
    bytes.fill(0);
  }
}

/**
 * The unit's key source: in the credentials directory, the file named
 * `mcf-recipient-` plus the key id's first 8 hex characters, read and imported
 * at each use. The directory is passed in by the entry point; this
 * module never reads the environment.
 */
export function credentialDirectoryKeySource(directory: string | undefined, files: McfKeyFiles = nodeKeyFiles): McfRecipientKeySource {
  const read = async (name: string): Promise<CreatorMcfRecipientKey> => {
    if (directory === undefined || directory === '') throw new McfCustodyError('key_unavailable');
    let bytes: Uint8Array;
    try {
      bytes = await files.readFile(join(directory, name));
    } catch {
      throw new McfCustodyError('key_unavailable');
    }
    return importKeyFile(bytes);
  };
  return {
    async load(keyId) {
      if (!KEY_ID.test(keyId)) throw new McfCustodyError('key_mismatch');
      const key = await read(mcfRecipientCredentialName(keyId));
      if (key.keyId !== keyId) throw new McfCustodyError('key_mismatch');
      return key;
    },
    async inventory() {
      if (directory === undefined || directory === '') throw new McfCustodyError('key_unavailable');
      let names: string[];
      try {
        names = (await files.readdir(directory)).filter((name) => name.startsWith(MCF_RECIPIENT_CREDENTIAL_PREFIX)).sort();
      } catch {
        throw new McfCustodyError('key_unavailable');
      }
      const keyIds: string[] = [];
      for (const name of names) {
        if (!CREDENTIAL_NAME.test(name)) throw new McfCustodyError('key_unavailable');
        const key = await read(name);
        if (mcfRecipientCredentialName(key.keyId) !== name) throw new McfCustodyError('key_mismatch');
        keyIds.push(key.keyId);
      }
      return keyIds;
    },
  };
}

/** Whether an address in `countryCode` may be sent from `marketplaceId`: the country's own marketplace only. */
export function mcfCountryAllowed(countryCode: string, marketplaceId: string): boolean {
  return /^[A-Z]{2}$/.test(countryCode) && marketplaceIdForCountry(countryCode) === marketplaceId;
}

/** What the claim says about the send's envelope (from the send row). */
export interface McfCustodyClaim {
  binding: CreatorMcfRecipientBinding;
  keyId: string;
  envelopeId: string;
  envelopeSha256: string;
  mask: CreatorMcfMask | null;
  marketplaceId: string;
}

/** What the custody read returned (ciphertext only). */
export interface McfCustodyRead {
  binding: CreatorMcfRecipientBinding;
  envelope: CreatorMcfSealedRecipient;
  ciphertextSha256: string;
}

export type McfCustodyRefusal = 'recipient_invalid' | 'mask_mismatch' | 'envelope_invalid' | 'envelope_unopenable' | 'key_mismatch'
  | 'key_unavailable' | 'country_not_allowed';

export type McfCustodyOpen =
  | { readonly status: 'opened'; readonly recipient: CreatorMcfRecipient; readonly mask: CreatorMcfMask }
  | { readonly status: 'refused'; readonly reason: McfCustodyRefusal; readonly codes: readonly string[]; readonly recipientRelated: boolean };

const refused = (reason: McfCustodyRefusal, codes: readonly string[] = []): McfCustodyOpen => ({
  status: 'refused', reason, codes, recipientRelated: reason === 'recipient_invalid' || reason === 'mask_mismatch' || reason === 'country_not_allowed',
});

const same = (left: unknown, right: unknown): boolean => {
  try {
    return creatorMcfCanonicalJson(left) === creatorMcfCanonicalJson(right);
  } catch {
    return false;
  }
};

export type McfEnvelopeOpener = (key: CreatorMcfRecipientKey, envelope: unknown, binding: CreatorMcfRecipientBinding) => Promise<CreatorMcfOpenResult>;

/**
 * Checks the custody read against the claim, reads and imports the key, opens
 * the envelope, validates the recipient and recomputes the mask. Returns the
 * recipient in memory, or a refusal with fixed codes. Never throws for a bad
 * envelope or key.
 */
export async function openMcfCustody(input: {
  claim: McfCustodyClaim;
  custody: McfCustodyRead;
  keys: McfRecipientKeySource;
  open?: McfEnvelopeOpener;
}): Promise<McfCustodyOpen> {
  const { claim, custody } = input;
  if (claim.mask === null || !same(custody.binding, claim.binding) || custody.envelope.envelopeId !== claim.envelopeId
    || custody.ciphertextSha256 !== claim.envelopeSha256) {
    return refused('envelope_invalid');
  }
  if (custody.envelope.keyId !== claim.keyId) return refused('key_mismatch');
  let digest: string;
  try {
    digest = await creatorMcfEnvelopeSha256(custody.envelope);
  } catch {
    return refused('envelope_invalid');
  }
  if (digest !== claim.envelopeSha256) return refused('envelope_invalid');
  if (!same(custody.envelope.mask, claim.mask)) return refused('mask_mismatch');
  // The ledger has no marketplace-to-country map, so the worker refuses a foreign address before decrypting it.
  if (!mcfCountryAllowed(claim.mask.countryCode, claim.marketplaceId)) return refused('country_not_allowed');
  let key: CreatorMcfRecipientKey;
  try {
    key = await input.keys.load(claim.keyId);
  } catch (error) {
    return refused(error instanceof McfCustodyError ? error.code : 'key_unavailable');
  }
  let result: CreatorMcfOpenResult;
  try {
    result = await (input.open ?? openCreatorMcfRecipient)(key, custody.envelope, claim.binding);
  } catch (error) {
    return refused(error instanceof CreatorMcfEnvelopeError ? error.code : 'envelope_unopenable');
  }
  if (result.status === 'recipient_invalid') {
    const codes = [...new Set(result.issues.map((issue) => `${issue.field ?? 'recipient'}.${issue.rule}`))].slice(0, MAX_CODES);
    return refused('recipient_invalid', codes);
  }
  if (result.status === 'mask_mismatch') return refused('mask_mismatch');
  const mask = creatorMcfMask(result.recipient);
  if (!same(mask, claim.mask) || !same(result.mask, claim.mask)) return refused('mask_mismatch');
  if (!mcfCountryAllowed(result.recipient.countryCode, claim.marketplaceId)) return refused('country_not_allowed');
  return { status: 'opened', recipient: result.recipient, mask };
}
