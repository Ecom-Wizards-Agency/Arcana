import { describe, expect, it } from 'vitest';
import { CampaignCreationApprovalView, type CampaignCreationApprovalSource } from '@wizard-ads/shared/campaign-creation-approval';
import { campaignCreationApprovalFixtures } from './creation-approval-fixtures';
import { projectCampaignCreationApproval } from './creation-approval-loader';

const scope = (source: CampaignCreationApprovalSource) => ({ orgId: source.plan.orgId,
  profileId: source.plan.profileId, planId: source.plan.id });
const otherId = '00000000-0000-4000-8000-000000000999';

describe('campaign recorded review server projection', () => {
  it.each(['orgId', 'profileId', 'planId'] as const)('refuses a foreign %s without disclosing its data', (key) => {
    const source = campaignCreationApprovalFixtures().sources.spManual;
    expect(() => projectCampaignCreationApproval({ ...scope(source), [key]: otherId }, source))
      .toThrow(/^Campaign review is unavailable$/);
  });

  it.each(['node', 'plan'] as const)('verifies %s digests rather than accepting a shape-valid saved record', (part) => {
    const source = campaignCreationApprovalFixtures().sources.spManual;
    if (part === 'node') {
      const campaign = source.plan.nodes.find((node) => node.kind === 'campaign.create')!;
      campaign.payload.name = 'Changed after approval';
    } else {
      source.plan.id = otherId;
    }
    expect(() => projectCampaignCreationApproval(scope(source), source)).toThrow('Campaign review is unavailable');
  });

  it.each([
    ['spManual', 5, 1, 4], ['spAutomatic', 4, 1, 3], ['sbVideoDetail', 6, 3, 3],
    ['sbVideoStore', 7, 4, 3], ['sdImage', 6, 2, 4], ['sdVideo', 6, 2, 4],
  ] as const)('preserves every frozen node and exact counts for %s', (name, totalNodes, readChecks, irreversibleCreates) => {
    const { sources, views } = campaignCreationApprovalFixtures();
    const view = CampaignCreationApprovalView.parse(views[name]);
    expect(view.plan).toEqual(sources[name].plan);
    expect(view.plan.counts).toMatchObject({ totalNodes, readChecks, irreversibleCreates,
      byKind: { 'campaign.create': 1 } });
    expect(view.plan.noRollbackAcknowledgement).toEqual({ required: true, rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive' });
    expect(view.freshness).toEqual({ status: 'current', reasons: [] });
    expect(view.admission.kind).toBe('unavailable');
    for (const node of view.plan.nodes) {
      if ('state' in node.payload) expect(node.payload.state).toBe('paused');
    }
    expect(view).not.toHaveProperty('canApprove');
    expect(view).not.toHaveProperty('actionUrl');
  });

  it('keeps bid inheritance, provider-created automatic clauses and explicit video destinations', () => {
    const { sources } = campaignCreationApprovalFixtures();
    const target = sources.spManual.plan.nodes.find((node) => node.kind === 'target.create')!;
    expect(target.payload.bid).toBeNull();
    expect(sources.spAutomatic.plan.counts.byKind['target.create']).toBe(0);
    for (const [name, destination] of [['sbVideoDetail', 'detail_page'], ['sbVideoStore', 'store']] as const) {
      const ad = sources[name].plan.nodes.find((node) => node.kind === 'ad.create');
      expect(ad?.payload).toMatchObject({ format: 'sb_product_video', landingPage: { type: destination } });
    }
  });

  it('retains the selected version when an observed version differs and separates processing from moderation', () => {
    const { views } = campaignCreationApprovalFixtures();
    const mismatch = views.assetVersionMismatch!;
    expect(mismatch.plan.nodes.find((node) => node.kind === 'asset.require_existing')?.payload.version).toBe('3');
    expect(mismatch.current.assets[0]!.observation!.identity.version).toBe('4');
    expect(mismatch.freshness.reasons).toContain('asset_identity_mismatch');
    expect(views.assetProcessing!.freshness.reasons).toContain('asset_processing');
    expect(views.assetProcessing!.current.assets[0]!.moderation).toBe('unknown');
    expect(views.assetMissing!.freshness.reasons).toContain('asset_unavailable');
  });

  it('never treats missing admission or missing execution evidence as known unapproved or queued', () => {
    const { views, interruptedRead } = campaignCreationApprovalFixtures();
    expect(views.knownUnapproved!.admission).toEqual({ kind: 'none' });
    expect(interruptedRead.map((view) => view.admission.kind)).toEqual(['unavailable', 'recorded', 'recorded']);
    expect(interruptedRead[1]!.admission).toMatchObject({ snapshot: null });
    expect(interruptedRead[2]!.admission).toMatchObject({ snapshot: { status: 'queued' } });
    expect(views.queued!.admission).not.toHaveProperty('receipt');
    expect(views.queued!.admission).not.toHaveProperty('execution');
    expect(views.queued!.admission).not.toHaveProperty('gateSnapshotDigest');
  });

  it('preserves recorded approval identity after expiry without emitting executable authority', () => {
    const source = campaignCreationApprovalFixtures().sources.queued;
    source.checkedAt = '2026-09-06T14:00:00.000Z';
    const view = projectCampaignCreationApproval(scope(source), source);
    expect(view.freshness.reasons).toContain('plan_expired');
    expect(view.admission).toMatchObject({ kind: 'recorded', approvedAt: '2026-09-06T12:03:00.000Z' });
    expect(view.recordedContext).toEqual({ guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' });
    expect(JSON.stringify(view)).not.toContain('authorizationId');
  });

  it('does not mutate or alias an input snapshot when repeated reads return detached views', () => {
    const source = campaignCreationApprovalFixtures().sources.sdVideo;
    const before = structuredClone(source);
    const first = projectCampaignCreationApproval(scope(source), source);
    const second = projectCampaignCreationApproval(scope(source), source);
    first.profile.label = 'Rendering-local edit';
    first.current.assets[0]!.observation!.identity.version = '99';
    expect(source).toEqual(before);
    expect(second.profile.label).toBe(before.profile.label);
    expect(second.current.assets[0]!.observation!.identity.version).toBe('3');
    expect(campaignCreationApprovalFixtures().sources.sdVideo).toEqual(before);
  });

  it('refuses mismatched execution counts instead of rendering optimistic success', () => {
    const source = campaignCreationApprovalFixtures().sources.queued;
    if (source.admission.kind !== 'recorded' || !source.admission.execution) throw new Error('Missing fixture');
    source.admission.execution.snapshot.accounting.succeeded = 1;
    expect(() => projectCampaignCreationApproval(scope(source), source)).toThrow('Campaign review is unavailable');
  });
});
