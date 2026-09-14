import { describe, expect, it } from 'vitest';
import {
  AssetLibraryIdentity, AssetLibraryObservation, AssetLibraryRegistration,
  AssetLibraryRegistrationOutcome, AssetLibrarySearchRequest, AssetLibrarySearchResult,
} from './asset-library.js';

const scope = { region: 'EU', amazonProfileId: '1000000001' } as const;
const observation = {
  scope, identity: { assetId: 'synthetic-video', version: 'version_1' },
  observedAt: '2026-09-06T12:00:00.000Z', assetType: 'video', name: 'Synthetic video',
  processing: 'active', specChecks: { approvedPrograms: null, failedSpecChecks: null },
};

describe('Asset Library contracts', () => {
  it('requires exact asset and version identity', () => {
    expect(AssetLibraryIdentity.safeParse({ assetId: 'synthetic-video' }).success).toBe(false);
    expect(AssetLibraryIdentity.safeParse({ assetId: 'synthetic-video', version: '' }).success).toBe(false);
    expect(AssetLibraryIdentity.parse(observation.identity)).toEqual(observation.identity);
  });

  it('separates processing from unknown program checks and excludes transport and moderation', () => {
    expect(AssetLibraryObservation.parse(observation).specChecks.approvedPrograms).toBeNull();
    for (const processing of ['processing', 'inactive', 'archived', 'unknown']) {
      expect(AssetLibraryObservation.safeParse({ ...observation, processing }).success).toBe(true);
    }
    for (const extra of [{ url: 'https://example.invalid/transient' }, { moderation: 'approved' }]) {
      expect(AssetLibraryObservation.safeParse({ ...observation, ...extra }).success).toBe(false);
    }
  });

  it('uses ranges plural and validates documented pagination bounds', () => {
    expect(AssetLibrarySearchRequest.parse({}).pageSize).toBe(100);
    expect(AssetLibrarySearchRequest.safeParse({ pageSize: 501 }).success).toBe(false);
    const filter = { rangeField: 'SIZE', ranges: [{ start: '10', end: '20' }] };
    expect(AssetLibrarySearchRequest.safeParse({ filterCriteria: { rangeFilters: [filter] } }).success).toBe(true);
    expect(AssetLibrarySearchRequest.safeParse({ filterCriteria: {
      rangeFilters: [{ rangeField: 'SIZE', range: filter.ranges }],
    } }).success).toBe(false);
  });

  it('reconciles all returned rows, identity uniqueness and the complete scope', () => {
    const result = { scope, assets: [observation],
      counts: { pages: 1, providerRows: 1, returnedRows: 1, totalRecords: 1 } };
    expect(AssetLibrarySearchResult.safeParse(result).success).toBe(true);
    for (const field of ['providerRows', 'returnedRows', 'totalRecords']) {
      expect(AssetLibrarySearchResult.safeParse({ ...result,
        counts: { ...result.counts, [field]: 2 } }).success).toBe(false);
    }
    expect(AssetLibrarySearchResult.safeParse({ ...result, assets: [observation, observation],
      counts: { pages: 1, providerRows: 2, returnedRows: 2, totalRecords: 2 } }).success).toBe(false);
    expect(AssetLibrarySearchResult.safeParse({ ...result,
      scope: { ...scope, amazonProfileId: '1000000002' } }).success).toBe(false);
  });

  it('validates registration subtype, linked version and excludes its temporary URL', () => {
    const registration = { name: 'Synthetic video', assetType: 'VIDEO', assetSubTypes: ['BACKGROUND_VIDEO'],
      linkedVersion: { assetId: 'synthetic-video', notes: 'Updated synthetic version' } };
    expect(AssetLibraryRegistration.safeParse(registration).success).toBe(true);
    expect(AssetLibraryRegistration.safeParse({ ...registration, assetSubTypes: ['LOGO'] }).success).toBe(false);
    expect(AssetLibraryRegistration.safeParse({ ...registration,
      url: 'https://example.invalid/transient' }).success).toBe(false);
  });

  it('retains failed specification evidence on acceptance without inventing eligibility', () => {
    const accepted = { kind: 'accepted', scope, identity: observation.identity,
      failedSpecChecks: [{ program: 'SPONSORED_BRANDS_VIDEO', specifications: [{ stringId: 'duration', passed: false }] }] };
    expect(AssetLibraryRegistrationOutcome.safeParse(accepted).success).toBe(true);
    expect(AssetLibraryRegistrationOutcome.safeParse({ ...accepted, eligible: true }).success).toBe(false);
    expect(AssetLibraryRegistrationOutcome.safeParse({ kind: 'uncertain', scope,
      reason: 'transport_failed', rawError: 'secret' }).success).toBe(false);
    expect(AssetLibraryRegistrationOutcome.safeParse({ kind: 'refused', scope, status: 500 }).success).toBe(false);
  });
});
