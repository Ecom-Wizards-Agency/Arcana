import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  creatorMcfEnvelopeSha256, creatorMcfRecipientKeyId, sealCreatorMcfRecipient, type CreatorMcfRecipient, type CreatorMcfRecipientBinding,
  type CreatorMcfRecipientKey, type CreatorMcfSealedRecipient,
} from '@wizard-ads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketplaceIdForCountry } from '../marketplaces.js';
import {
  McfCustodyError, credentialDirectoryKeySource, mcfCountryAllowed, mcfRecipientCredentialName, openMcfCustody, type McfCustodyClaim, type McfCustodyOpen,
  type McfCustodyRead, type McfEnvelopeOpener, type McfKeyFiles,
} from './custody.js';

const US = marketplaceIdForCountry('US')!;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
/** Unique synthetic tokens, one per recipient field, made at run time. */
const token = (label: string) => `${label}${hex(4)}`;

interface KeyPair { der: Buffer; jwk: Record<string, unknown>; keyId: string }
async function keyPair(): Promise<KeyPair> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const jwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  return { der, jwk, keyId: await creatorMcfRecipientKeyId(jwk) };
}

function canaryRecipient(): CreatorMcfRecipient {
  return {
    name: token('Qzname'), addressLine1: `${token('Qzstreet')} 12`, addressLine2: token('Qzunit'), city: token('Qzcity'),
    stateOrRegion: token('Qzstate'), postalCode: `QZ${hex(6).toUpperCase()}`, countryCode: 'US',
  };
}
const canaries = (recipient: CreatorMcfRecipient): string[] => Object.values(recipient).filter((value) => value.length >= 6);

function binding(): CreatorMcfRecipientBinding {
  return { orgId: randomUUID(), creatorRecordId: `CCR-SW-26-${1000 + Math.floor(Math.random() * 8999)}`, asin: `B0${hex(4).toUpperCase()}`,
    derivedOrderKey: `CCS-${hex(16)}`, reservationId: `MCFR-${hex(8).toUpperCase()}` } as CreatorMcfRecipientBinding;
}

/** Counts reads through the real file system. */
function countingFiles(): McfKeyFiles & { reads: number } {
  const files = {
    reads: 0,
    async readFile(path: string) { files.reads += 1; return readFile(path); },
    async readdir(path: string) { const { readdir } = await import('node:fs/promises'); return readdir(path); },
  };
  return files;
}

describe('MCF custody: key source and open', () => {
  let dir: string;
  let key: KeyPair;
  let other: KeyPair;
  const lane = binding();
  const recipient = canaryRecipient();
  let envelope: CreatorMcfSealedRecipient;
  let claim: McfCustodyClaim;
  let custody: McfCustodyRead;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wp338e-keys-'));
    key = await keyPair();
    other = await keyPair();
    await writeFile(join(dir, mcfRecipientCredentialName(key.keyId)), key.der);
    envelope = await sealCreatorMcfRecipient(key.jwk, key.keyId, lane, recipient);
    const sha = await creatorMcfEnvelopeSha256(envelope);
    claim = { binding: lane, keyId: key.keyId, envelopeId: envelope.envelopeId, envelopeSha256: sha, mask: envelope.mask, marketplaceId: US };
    custody = { binding: lane, envelope, ciphertextSha256: sha };
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('opens in memory with a key read from the credentials directory at every open, and recomputes the mask', async () => {
    const files = countingFiles();
    const keys = credentialDirectoryKeySource(dir, files);
    const first = await openMcfCustody({ claim, custody, keys });
    const second = await openMcfCustody({ claim, custody, keys });
    expect(first).toEqual({ status: 'opened', recipient, mask: envelope.mask });
    expect(second.status).toBe('opened');
    // Per-open import: nothing cached, one file read per open.
    expect(files.reads).toBe(2);
  });

  it('a removed or replaced key file takes effect at the next open', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'wp338e-rotate-'));
    const path = join(scratch, mcfRecipientCredentialName(key.keyId));
    await writeFile(path, key.der);
    const keys = credentialDirectoryKeySource(scratch);
    expect((await openMcfCustody({ claim, custody, keys })).status).toBe('opened');
    await rm(path);
    expect(await openMcfCustody({ claim, custody, keys })).toMatchObject({ status: 'refused', reason: 'key_unavailable' });
    // Another key under this key id's name.
    await writeFile(path, other.der);
    expect(await openMcfCustody({ claim, custody, keys })).toMatchObject({ status: 'refused', reason: 'key_mismatch' });
    await rm(scratch, { recursive: true, force: true });
  });

  it('zeroes the key bytes it read', async () => {
    const held: Uint8Array[] = [];
    const files: McfKeyFiles = {
      readFile: async () => { const bytes = new Uint8Array(key.der); held.push(bytes); return bytes; },
      readdir: async () => [mcfRecipientCredentialName(key.keyId)],
    };
    const loaded: CreatorMcfRecipientKey = await credentialDirectoryKeySource('/credentials', files).load(key.keyId);
    expect(loaded.keyId).toBe(key.keyId);
    expect(held).toHaveLength(1);
    expect(held[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ['no credentials directory', undefined, 'key_unavailable'],
    ['an empty credentials directory path', '', 'key_unavailable'],
  ])('%s refuses as %s', async (_name, directory, reason) => {
    expect(await openMcfCustody({ claim, custody, keys: credentialDirectoryKeySource(directory) })).toMatchObject({ status: 'refused', reason });
  });

  it('refuses a PEM file, an oversized file and a key of another curve without reading anything else', async () => {
    // A PEM file, its armour assembled at run time.
    const armour = (edge: string) => ['-----', edge, ' PRIVATE', ' KEY', '-----'].join('');
    const pem = Buffer.from(`${armour('BEGIN')}\n${key.der.toString('base64')}\n${armour('END')}\n`);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'der', type: 'pkcs8' });
    for (const bytes of [pem, Buffer.alloc(5000, 0x30), rsa, Buffer.alloc(0)]) {
      const files: McfKeyFiles = { readFile: async () => new Uint8Array(bytes), readdir: async () => [] };
      expect(await openMcfCustody({ claim, custody, keys: credentialDirectoryKeySource('/credentials', files) }))
        .toMatchObject({ status: 'refused', reason: 'key_unavailable' });
    }
  });

  it('checks the envelope against the claim before any key is read', async () => {
    const files = countingFiles();
    const keys = credentialDirectoryKeySource(dir, files);
    const cases: [string, McfCustodyClaim, McfCustodyRead, string][] = [
      ['another key id on the envelope', claim, { ...custody, envelope: { ...envelope, keyId: other.keyId } }, 'key_mismatch'],
      ['another key id on the claim', { ...claim, keyId: other.keyId }, custody, 'key_mismatch'],
      ['a mask that differs from the send row', { ...claim, mask: { ...claim.mask!, lines: 3 } }, custody, 'mask_mismatch'],
      ['a mask missing from the send row', { ...claim, mask: null }, custody, 'envelope_invalid'],
      ['another binding in custody', claim, { ...custody, binding: { ...lane, reservationId: `MCFR-${hex(8).toUpperCase()}` } as CreatorMcfRecipientBinding }, 'envelope_invalid'],
      ['another envelope id', { ...claim, envelopeId: randomUUID() }, custody, 'envelope_invalid'],
      ['another ciphertext digest', { ...claim, envelopeSha256: hex(32) }, { ...custody, ciphertextSha256: hex(32) }, 'envelope_invalid'],
      ['a digest that does not match the ciphertext', { ...claim, envelopeSha256: hex(32) }, custody, 'envelope_invalid'],
      ['an address outside the send\'s marketplace', { ...claim, marketplaceId: marketplaceIdForCountry('CA')! }, custody, 'country_not_allowed'],
    ];
    for (const [name, badClaim, badCustody, reason] of cases) {
      expect(await openMcfCustody({ claim: badClaim, custody: badCustody, keys }), name).toMatchObject({ status: 'refused', reason });
    }
    expect(files.reads).toBe(0);
  });

  it('a tampered binding on both sides fails to open (the associated data)', async () => {
    const tampered = { ...lane, asin: `B0${hex(4).toUpperCase()}` } as CreatorMcfRecipientBinding;
    const result = await openMcfCustody({ claim: { ...claim, binding: tampered }, custody: { ...custody, binding: tampered },
      keys: credentialDirectoryKeySource(dir) });
    expect(result).toMatchObject({ status: 'refused', reason: 'envelope_unopenable' });
  });

  it('maps the opener\'s answers to fixed codes and re-checks the opened recipient', async () => {
    const keys = credentialDirectoryKeySource(dir);
    const opener = (result: Awaited<ReturnType<McfEnvelopeOpener>>): McfEnvelopeOpener => async () => result;
    expect(await openMcfCustody({ claim, custody, keys, open: opener({ status: 'recipient_invalid', issues: [
      { field: 'stateOrRegion', rule: 'state_required' }, { field: null, rule: 'malformed' }, { field: 'phone', rule: 'forbidden_field' }] }) }))
      .toEqual({ status: 'refused', reason: 'recipient_invalid', codes: ['stateOrRegion.state_required', 'recipient.malformed', 'phone.forbidden_field'],
        recipientRelated: true });
    expect(await openMcfCustody({ claim, custody, keys, open: opener({ status: 'mask_mismatch' }) }))
      .toMatchObject({ status: 'refused', reason: 'mask_mismatch', recipientRelated: true });
    // The worker recomputes the mask itself: an opener that returns a recipient with another postal code is refused.
    expect(await openMcfCustody({ claim, custody, keys, open: opener({ status: 'opened', recipient: { ...recipient, postalCode: 'ZZ99' }, mask: claim.mask! }) }))
      .toMatchObject({ status: 'refused', reason: 'mask_mismatch' });
    expect(await openMcfCustody({ claim, custody, keys, open: opener({ status: 'opened', recipient: { ...recipient, countryCode: 'CA' },
      mask: { ...claim.mask!, countryCode: 'CA' } }) })).toMatchObject({ status: 'refused', reason: 'mask_mismatch' });
    const thrown: McfEnvelopeOpener = async () => { throw new Error(`boom ${recipient.name}`); };
    expect(await openMcfCustody({ claim, custody, keys, open: thrown })).toMatchObject({ status: 'refused', reason: 'envelope_unopenable' });
  });

  it('no refusal, result or error carries a recipient value', async () => {
    const results: McfCustodyOpen[] = [];
    const keys = credentialDirectoryKeySource(dir);
    results.push(await openMcfCustody({ claim: { ...claim, marketplaceId: marketplaceIdForCountry('CA')! }, custody, keys }));
    results.push(await openMcfCustody({ claim, custody, keys, open: async () => { throw new Error(recipient.name); } }));
    results.push(await openMcfCustody({ claim, custody, keys: credentialDirectoryKeySource(undefined) }));
    const text = JSON.stringify(results).toLowerCase();
    for (const value of canaries(recipient)) expect(text).not.toContain(value.toLowerCase());
    const error = new McfCustodyError('key_unavailable');
    expect(error.message).toBe('key_unavailable');
  });

  it('lists every readable key, and refuses a directory with a bad or misnamed key file', async () => {
    expect(await credentialDirectoryKeySource(dir).inventory()).toEqual([key.keyId]);
    const scratch = await mkdtemp(join(tmpdir(), 'wp338e-inventory-'));
    await writeFile(join(scratch, mcfRecipientCredentialName(key.keyId)), key.der);
    await writeFile(join(scratch, 'unrelated-credential'), 'not a key');
    expect(await credentialDirectoryKeySource(scratch).inventory()).toEqual([key.keyId]);
    await writeFile(join(scratch, mcfRecipientCredentialName(other.keyId).replace(/.$/, (c) => (c === '0' ? '1' : '0'))), other.der);
    await expect(credentialDirectoryKeySource(scratch).inventory()).rejects.toMatchObject({ code: 'key_mismatch' });
    await rm(scratch, { recursive: true, force: true });
    const empty = await mkdtemp(join(tmpdir(), 'wp338e-empty-'));
    expect(await credentialDirectoryKeySource(empty).inventory()).toEqual([]);
    await writeFile(join(empty, 'mcf-recipient-nothex!'), key.der);
    await expect(credentialDirectoryKeySource(empty).inventory()).rejects.toMatchObject({ code: 'key_unavailable' });
    await rm(empty, { recursive: true, force: true });
    await expect(credentialDirectoryKeySource(undefined).inventory()).rejects.toBeInstanceOf(McfCustodyError);
  });

  it('never reads the private key from the environment', async () => {
    const source = await readFile(fileURLToPath(new URL('./custody.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/process\.env|process\[/);
    // A key placed in the environment is ignored: without a directory nothing opens.
    const saved = process.env['MCF_RECIPIENT_KEY'];
    process.env['MCF_RECIPIENT_KEY'] = key.der.toString('base64');
    try {
      expect(await openMcfCustody({ claim, custody, keys: credentialDirectoryKeySource(undefined) })).toMatchObject({ status: 'refused', reason: 'key_unavailable' });
    } finally {
      if (saved === undefined) delete process.env['MCF_RECIPIENT_KEY'];
      else process.env['MCF_RECIPIENT_KEY'] = saved;
    }
  });

  it('allows a country only on its own marketplace', () => {
    expect(mcfCountryAllowed('US', US)).toBe(true);
    expect(mcfCountryAllowed('CA', US)).toBe(false);
    expect(mcfCountryAllowed('us', US)).toBe(false);
    expect(mcfCountryAllowed('GB', marketplaceIdForCountry('GB')!)).toBe(true);
  });
});
