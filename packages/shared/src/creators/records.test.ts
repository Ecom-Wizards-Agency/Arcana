/**
 * Round-2 contracts: contact data refused by shape wherever it appears, the
 * reply templates and tracker statuses, draft invariants, and the MCP inputs'
 * cross-field rules. Contact-shaped strings are assembled from fragments at run
 * time so the repository holds none. Synthetic values only.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREATOR_REPLY_TEMPLATES, CreatorAppendActionInput, CreatorDraft, CreatorRegisterRecordInput, CreatorReplyTemplateKey, CreatorSubmitDraftInput,
  creatorContactShapes, creatorReplyTemplateName, findCreatorContactData, isRecognisedCreatorStatus,
} from './records.js';
import { CreatorRunnerResolution } from './runner.js';
import { CreatorIdleGroup } from './model.js';

const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');
const at = ['@'].join('');
const email = ['creator.synthetic', at, 'example', '.test'].join('');
const phones = [['+49', '151', '2345', '6789'].join(' '), ['0151', '23456789'].join('-'), ['(555)', '010-0199'].join(' ')];
const addresses = [['12', 'Synthetic Street'].join(' '), ['Beispielstraße', '7'].join(' '), ['Am Hang', ['10115', 'Berlin'].join(' ')].join(', ')];
const link = ['https', '://', 'example.test/shop/synthetic'].join('');

const registry = (change: Record<string, unknown> = {}) => ({
  creator_record_id: 'CCR-SW-26-0134', brand: 'Synthetic brand', campaign_id: 'campaign-synthetic-1', thread_key: fp('thread'),
  storefront_key: fp('storefront'), full_name_fp: '', email_fp: fp('email'), phone_fp: '', address_fp: '', record_state: 'Active',
  lock_state: 'Unlocked', version: 1, created_at: '2026-09-01', ...change,
});

describe('raw contact data is refused by shape', () => {
  it('finds each shape', () => {
    expect(creatorContactShapes(`write to ${email}`)).toEqual(['email']);
    for (const phone of phones) expect(creatorContactShapes(`call ${phone} today`), phone).toEqual(['phone']);
    for (const address of addresses) expect(creatorContactShapes(`ship to ${address}`), address).toEqual(['address']);
    expect(creatorContactShapes(`see ${link}`)).toEqual(['link']);
  });

  it('passes the values the runner and a draft legitimately carry', () => {
    const clean = [
      fp('thread'), 'CCR-SW-26-0134', '20260909-CCR-SW-26-0134', 'sweep-20260909-0612', 'MCFR-9F2C41AB77E0D3B5', 'MCFR-LEGACY-0123456789AB', 'B0D9K3M2QP',
      'SW-DERMA-05-FBA', '2026-09-09', '2026-09-08T06:44:00.123456+00:00', '2026-09-09 06:35:22', 'ev:sweep-0909', 'ev:mcf-inv-16',
      'message_send_requires_current_approval;missing_complete_fulfillment_details', 'Delivered / Awaiting Content',
      'Hi there, your sample is now on the way. Please reply with B0D9K3M2QP to confirm, within 2 days.',
      'Full name\nEmail address\nPhone number\nComplete shipping address\nConfirmed product + ASIN',
    ];
    for (const value of clean) expect(creatorContactShapes(value), value).toEqual([]);
  });

  it('finds the shapes a first pass missed: bare-domain links, labelled phones, non-ASCII addresses', () => {
    expect(creatorContactShapes(['see', ['amazon', '.de/shop/synthetic-handle'].join('')].join(' '))).toEqual(['link']);
    expect(creatorContactShapes(['example', '.test/some/path'].join(''))).toEqual(['link']);
    for (const labelled of [['tel:', '+4915123456789'].join(''), ['Phone:', '0151 2345678'].join(''), ['Tel.', '0151-2345678'].join('')]) {
      expect(creatorContactShapes(labelled), labelled).toEqual(['phone']);
    }
    expect(creatorContactShapes(['jürgen.synthetic', '@', 'beispiel', '.test'].join(''))).toEqual(['email']);
  });

  it('passes German body text a first pass mistook for contact data, and still refuses real addresses', () => {
    for (const clean of ['Versand am 01.10.2026 geplant', 'Zeitstempel 1727400000', 'Das Video hat 10000 Aufrufe', 'Platz 1 in der Kategorie',
      'after 5 road trips with it']) {
      expect(creatorContactShapes(clean), clean).toEqual([]);
    }
    for (const address of [...addresses, ['Beispielweg', '3a'].join(' '), ['Marktplatz', '12'].join(' ')]) {
      expect(creatorContactShapes(`ship to ${address}`), address).toEqual(['address']);
    }
  });

  it('refuses contact data in keys, whether the key names it or is it, and never echoes such a key', () => {
    for (const key of ['email_address', 'phone_number', 'shipping_address']) {
      expect(findCreatorContactData({ [key]: 'x' }), key).toEqual([{ path: key, shape: 'contact_key' }]);
    }
    const hits = findCreatorContactData({ body: 'x', [email]: 1 });
    expect(hits).toEqual([{ path: '[key 1]', shape: 'email' }]);
    expect(JSON.stringify(hits)).not.toContain(email);
    expect(findCreatorContactData({ email_fp: fp('e'), address_fp: fp('a'), full_name_fp: '', storefront_key: fp('s'), recipient_binding: fp('r') })).toEqual([]);
  });

  it('walks every string and key, and reports where, never what', () => {
    const hits = findCreatorContactData({ record: { brand: `Brand ${email}`, notes: [phones[0]] }, email: 'x', body: addresses[1] });
    expect(hits).toEqual([
      { path: 'record.brand', shape: 'email' }, { path: 'record.notes[0]', shape: 'phone' },
      { path: 'email', shape: 'contact_key' }, { path: 'body', shape: 'address' },
    ]);
    expect(JSON.stringify(hits)).not.toContain(email);
    expect(findCreatorContactData(registry())).toEqual([]);
  });
});

describe('templates, statuses and drafts', () => {
  it('lists the reply playbook templates once each, by key and heading', () => {
    expect(CREATOR_REPLY_TEMPLATES).toHaveLength(11);
    expect(CREATOR_REPLY_TEMPLATES.every((template) => (template.names as readonly string[]).includes('{first name}'))).toBe(true);
    expect(CREATOR_REPLY_TEMPLATES.filter((template) => (template.names as readonly string[]).includes('{recipient name}')).map((template) => template.key))
      .toEqual(['recipient_mismatch_clarification']);
    expect(new Set(CREATOR_REPLY_TEMPLATES.map((template) => template.key)).size).toBe(11);
    expect(CreatorReplyTemplateKey.options).toHaveLength(11);
    expect(creatorReplyTemplateName('awaiting_content_follow_up')).toBe('Awaiting content follow-up');
  });

  it('recognises the tracker dropdown and the product pause pattern, and nothing else', () => {
    for (const status of ['Verification Confirmed', 'Delivered / Awaiting Content', 'Derma stamp Pause', 'Declined / Closed']) {
      expect(isRecognisedCreatorStatus(status), status).toBe(true);
    }
    for (const status of ['Awaiting Sample', 'verified', 'Pause', '']) expect(isRecognisedCreatorStatus(status), status).toBe(false);
    expect(CreatorIdleGroup.safeParse({ status: null, recognised: false, records: 1 }).success).toBe(false);
  });

  it('keeps approval and closing times consistent with the status', () => {
    const base = { id: '33300000-0000-4000-8000-0000000000aa', creatorRecordId: 'CCR-SW-26-0134', threadKey: fp('thread'),
      templateKey: 'proof_request', body: 'Synthetic text.', draftDate: '2026-09-09', status: 'draft', createdBy: null,
      createdAt: '2026-09-09T06:00:00.000Z', approvedBy: null, approvedAt: null, closedBy: null, closedAt: null, source: 'mcp' };
    const approved = { approvedBy: '33300000-0000-4000-8000-000000000001', approvedAt: '2026-09-09T07:00:00.000Z' };
    const closed = { closedBy: '33300000-0000-4000-8000-000000000001', closedAt: '2026-09-09T08:00:00.000Z' };
    expect(CreatorDraft.safeParse(base).success).toBe(true);
    expect(CreatorDraft.safeParse({ ...base, status: 'approved', ...approved }).success).toBe(true);
    expect(CreatorDraft.safeParse({ ...base, status: 'withdrawn', ...closed }).success).toBe(true);
    expect(CreatorDraft.safeParse({ ...base, status: 'withdrawn', ...approved, ...closed }).success).toBe(true);
    expect(CreatorDraft.safeParse({ ...base, status: 'approved' }).success).toBe(false);
    expect(CreatorDraft.safeParse({ ...base, ...approved }).success).toBe(false);
    expect(CreatorDraft.safeParse({ ...base, status: 'sent_by_hand', ...approved }).success).toBe(false);
  });
});

describe('creator:write inputs', () => {
  it('registers a record only with a resolution that names it', () => {
    const resolved = { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0134', match_method: 'storefront' };
    expect(CreatorRegisterRecordInput.safeParse({ record: registry(), resolution: resolved }).success).toBe(true);
    expect(CreatorRegisterRecordInput.safeParse({ record: registry(), resolution: { ...resolved, creator_record_id: 'CCR-SW-26-0091' } }).success).toBe(false);
    const conflict = { result: 'CONFLICT', reason: 'multiple_active_records_match', matches: ['CCR-SW-26-0134', 'CCR-SW-26-0203'] };
    expect(CreatorRegisterRecordInput.safeParse({ record: registry({ lock_state: 'Conflict' }), resolution: conflict }).success).toBe(true);
    expect(CreatorRegisterRecordInput.safeParse({ record: registry(), resolution: conflict }).success).toBe(false);
    const fingerprints = { thread_key: fp('thread'), storefront_key: fp('storefront'), full_name_fp: '', email_fp: fp('email'), phone_fp: '', address_fp: '' };
    expect(CreatorRegisterRecordInput.safeParse({ record: registry(), resolution: { result: 'NEW', fingerprints } }).success).toBe(true);
    expect(CreatorRegisterRecordInput.safeParse({ record: registry(), resolution: { result: 'NEW', fingerprints: { ...fingerprints, phone_fp: fp('phone') } } }).success).toBe(false);
    expect(CreatorRegisterRecordInput.safeParse({ record: registry(), resolution: { result: 'HOLD', reason: 'record_is_locked' } }).success).toBe(false);
    expect(CreatorRegisterRecordInput.safeParse({ record: { ...registry(), email: 'x' }, resolution: resolved }).success).toBe(false);
    expect(CreatorRunnerResolution.options).toHaveLength(4);
  });

  it('refuses a repeated event key and an action the skill may not append', () => {
    const entry = { event_key: 'sent-1', creator_record_id: 'CCR-SW-26-0134', action: 'message_sent_by_hand', occurred_at: '2026-09-09T06:38:00Z' };
    expect(CreatorAppendActionInput.safeParse({ entries: [entry] }).success).toBe(true);
    expect(CreatorAppendActionInput.safeParse({ entries: [entry, entry] }).success).toBe(false);
    expect(CreatorAppendActionInput.safeParse({ entries: [{ ...entry, action: 'draft_approved' }] }).success).toBe(false);
    expect(CreatorAppendActionInput.safeParse({ entries: [{ ...entry, action: 'mcf_reserved' }] }).success).toBe(false);
  });

  it('takes a draft from an approved template only, and never a blank one', () => {
    const draft = { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('thread'), template_key: 'sample_confirmation', draft_date: '2026-09-09',
      body: 'Hi {first name}, synthetic.' };
    expect(CreatorSubmitDraftInput.safeParse(draft).success).toBe(true);
    // A rendered name is refused: the placeholder stays for the operator to fill in by hand.
    expect(CreatorSubmitDraftInput.safeParse({ ...draft, body: 'Hi Synthetic, synthetic.' }).success).toBe(false);
    const mismatch = { ...draft, template_key: 'recipient_mismatch_clarification' };
    expect(CreatorSubmitDraftInput.safeParse(mismatch).success).toBe(false);
    expect(CreatorSubmitDraftInput.safeParse({ ...mismatch, body: 'Hi {first name}, is {recipient name} the recipient?' }).success).toBe(true);
    expect(CreatorSubmitDraftInput.safeParse({ ...draft, template_key: 'free_text' }).success).toBe(false);
    expect(CreatorSubmitDraftInput.safeParse({ ...draft, body: '   ' }).success).toBe(false);
    expect(CreatorSubmitDraftInput.safeParse({ ...draft, body: 'x'.repeat(4001) }).success).toBe(false);
  });
});
