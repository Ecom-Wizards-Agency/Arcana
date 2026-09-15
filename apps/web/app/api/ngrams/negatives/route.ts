import { buildNgramNegativeReview, ngramCalculationTrace } from '@wizard-ads/core';
import { loadSearchTermRows } from '../../../../src/ngrams/data';
/**
 * "Propose as negative" from the n-gram explorer.
 *
 * It creates proposals. It negates nothing: v1 writes nothing to Amazon, and a
 * one-click negative that actually negated would be the one place in this
 * product where a click leaves the review loop. The rows land in their own run
 * marked `ngram-explorer`, so a proposal an operator clicked is never
 * indistinguishable from one the White Box formula produced.
 *
 * Each proposal carries the gram's own evidence as its `inputs`, so it arrives
 * in the review surface with its work shown like every other proposal rather
 * than as an assertion.
 */
import { createNegativeProposalsForActor } from '@wizard-ads/db';
import type { NegativeProposalInput } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';

const MATCH_TYPES: readonly string[] = ['negative_exact', 'negative_phrase'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface IncomingProposal {
  searchTerm?: unknown;
  campaignId?: unknown;
  adGroupId?: unknown;
  matchType?: unknown;
  clicks?: unknown;
  rpc?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (database) => {
    const actor = database.actor;

    const body = (await mutationBody(request)) as {
      profileId?: unknown;
      window?: unknown;
      proposals?: unknown;
      gram?: unknown; n?: unknown; selectedTerms?: unknown;
    };
    if (typeof body.profileId !== 'string') throw new MutationInputError('profileId is required');
    const incomingWindow = body.window as { start?: unknown; end?: unknown } | undefined;
    if (
      incomingWindow === undefined ||
      typeof incomingWindow.start !== 'string' ||
      typeof incomingWindow.end !== 'string' ||
      !ISO_DATE.test(incomingWindow.start) ||
      !ISO_DATE.test(incomingWindow.end)
    ) {
      throw new MutationInputError('window must carry ISO start and end dates');
    }
    const window: { start: string; end: string } = {
      start: incomingWindow.start,
      end: incomingWindow.end,
    };
    if (!Array.isArray(body.proposals) || body.proposals.length === 0) {
      throw new MutationInputError('proposals must be a non-empty array');
    }

    // The profile has to belong to the caller's org. `ad_profiles` carries the
    // org, so this is one statement and not a trust decision.
    const owned = await database.sql<{ exists: boolean }[]>`
      select exists(
        select 1 from public.ad_profiles
         where id = ${body.profileId} and org_id = ${actor.orgId}
      ) as exists
    `;
    if (!owned[0]?.exists) throw new MutationInputError('Not found', 404);

    if (typeof body.gram === 'string') {
      if (![1,2,3].includes(Number(body.n))) throw new MutationInputError('Invalid gram size');
      const payload = await loadSearchTermRows(database,{orgId:actor.orgId,profileId:body.profileId,period:window});
      if(payload.truncated) throw new MutationInputError('Narrow the period before proposing negatives');
      const [profile] = await database.sql<{target_acos:number|null}[]>`select target_acos::float8 as target_acos from public.ad_profiles where id=${body.profileId} and org_id=${actor.orgId}`;
      const orders=payload.rows.reduce((n,r)=>n+r.purchases7d,0),sales=payload.rows.reduce((n,r)=>n+r.sales7d,0);
      if(!profile?.target_acos||orders<=0)throw new MutationInputError('Target ACOS and average order value are required');
      if(!Array.isArray(body.selectedTerms)||body.selectedTerms.some(id=>typeof id!=='string'))throw new MutationInputError('Selected term identities are required');
      const selected=new Set(body.selectedTerms as string[]);
      const selectedRows=payload.rows.filter(r=>selected.has(`${r.campaignId??''}|${r.adGroupId??''}|${r.searchTerm}`));
      if(selectedRows.length!==selected.size)throw new MutationInputError('Search-term evidence changed. Reload before reviewing.');
      const review=buildNgramNegativeReview(selectedRows,body.gram,Number(body.n),{targetAcos:profile.target_acos,aov:sales/orders});
      if(!review||review.rows.length!==body.proposals.length)throw new MutationInputError('Negative evidence changed. Reload before reviewing.');
      const proposals:NegativeProposalInput[]=review.rows.map(row=>{
        const matches=(body.proposals as Record<string,unknown>[]).filter(p=>p['campaignId']===row.campaignId&&p['adGroupId']===row.adGroupId);
        const incoming=matches[0];
        if(matches.length!==1||!incoming
          ||incoming['searchTerm']!==review.gram
          ||!MATCH_TYPES.includes(String(incoming['matchType']))
          ||incoming['spend']!==row.spend
          ||incoming['clicks']!==row.clicks
          ||incoming['searchTerms']!==row.searchTerms)throw new MutationInputError('Reviewed rows changed. Reload before reviewing.');
        const expected={...review.options,spend:review.candidate.cost,sales:review.candidate.sales,orders:review.candidate.purchases,reason:review.candidate.reason};
        if(JSON.stringify(incoming['gramInputs'])!==JSON.stringify(expected))throw new MutationInputError('Engine inputs changed. Review the new calculation.');
        return {searchTerm:review.gram,campaignId:row.campaignId,adGroupId:row.adGroupId,matchType:incoming['matchType'] as NegativeProposalInput['matchType'],inputs:{
          rpc:row.clicks>0?row.sales/row.clicks:null,clicks:row.clicks,cvrSourceLevel:'keyword',ceilingApplied:null,capClamped:false,window,trace:ngramCalculationTrace(review)}};
      });
      const result=await createNegativeProposalsForActor(database,{profileId:body.profileId,window,lookbackDays:Math.round((Date.parse(window.end)-Date.parse(window.start))/86400000)+1,proposals});
      return Response.json({...result,offered:proposals.length},{status:201});
    }

    const proposals: NegativeProposalInput[] = (body.proposals as IncomingProposal[]).map(
      (proposal, index) => {
        if (typeof proposal.searchTerm !== 'string' || proposal.searchTerm.trim().length === 0) {
          throw new MutationInputError(`proposal ${index} needs a search term`);
        }
        if (typeof proposal.campaignId !== 'string') {
          throw new MutationInputError(`proposal ${index} needs a campaign id`);
        }
        const matchType =
          typeof proposal.matchType === 'string' && MATCH_TYPES.includes(proposal.matchType)
            ? (proposal.matchType as NegativeProposalInput['matchType'])
            : 'negative_exact';
        const clicks =
          typeof proposal.clicks === 'number' && Number.isFinite(proposal.clicks)
            ? Math.max(0, Math.trunc(proposal.clicks))
            : 0;
        const rpc = typeof proposal.rpc === 'number' && Number.isFinite(proposal.rpc) ? proposal.rpc : null;
        return {
          searchTerm: proposal.searchTerm.trim(),
          campaignId: proposal.campaignId,
          adGroupId: typeof proposal.adGroupId === 'string' ? proposal.adGroupId : null,
          matchType,
          inputs: {
            rpc,
            clicks,
            // `keyword` is the most specific level the contract has, and it is
            // the right one: the evidence is the search term's own pooled
            // performance under the target it matched through, not a benchmark
            // borrowed from a level above it.
            cvrSourceLevel: 'keyword',
            ceilingApplied: null,
            capClamped: false,
            window: { start: window.start, end: window.end },
          },
        };
      },
    );

    const lookbackDays =
      Math.round(
        (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) /
          86_400_000,
      ) + 1;

    const result = await createNegativeProposalsForActor(database, {
      profileId: body.profileId,
      window: { start: window.start, end: window.end },
      lookbackDays,
      proposals,
    });

    return Response.json({ ...result, offered: proposals.length }, { status: 201 });
  });
}
