import type { CalculationTrace, CalculationStep } from '@wizard-ads/shared';
/**
 * N-gram aggregation over search-term facts, plus negative candidates.
 *
 * New code, not a port: the Python toolkit has no n-gram module. The shape it
 * has to fit is the one the reference engine already implies. A search-term
 * report is thousands of rows of which most have one or two clicks, so no
 * single row carries evidence; the signal lives in the words those rows share.
 * Aggregating to uni/bi/tri-grams pools that evidence.
 *
 * Two decisions worth stating, because both are places a naive implementation
 * quietly lies:
 *
 * - A gram is counted ONCE per search term, however many times it occurs in
 *   it. "blue widget blue case" must not book its spend against "blue" twice.
 * - Spend is attributed to every gram a term contains, so gram totals overlap
 *   and DO NOT sum to account spend. That is inherent to n-gram analysis; the
 *   `searchTerms` count on each row is what keeps a reader honest about it.
 *
 * A negative candidate is a proposal, never an action, and it carries the
 * evidence that produced it.
 */
import { safeDiv } from './num.js';

/** The subset of a search-term fact this module needs. Field names match `SearchTermFact`. */
export interface SearchTermRow {
  searchTerm: string;
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  campaignId?: string;
  adGroupId?: string;
  targetId?: string | null;
  matchType?: string | null;
}

export interface NgramRow {
  gram: string;
  /** 1, 2 or 3. */
  n: number;
  /** Distinct search terms this gram appeared in. */
  searchTerms: number;
  impressions: number;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
  ctr: number | null;
  cvr: number | null;
  cpc: number | null;
  /** Revenue per click, the input to every White Box bid. */
  rpc: number | null;
  acos: number | null;
}

export type NegativeReason = 'no_sales_over_target_cpa' | 'acos_over_ceiling';

export interface NegativeCandidate {
  searchTerm: string;
  reason: NegativeReason;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
  acos: number | null;
  /** The threshold the row crossed, so the proposal can be argued with. */
  threshold: number;
}

export interface NgramOptions {
  /** Gram sizes to build. Defaults to uni, bi and tri. */
  sizes?: number[];
  /** Drop grams whose pooled clicks fall below this. Defaults to 0 (keep all). */
  minClicks?: number;
}

const TOKEN_SPLIT = /[^\p{L}\p{N}+&']+/u;

/** Lowercase, split on non-word runs, drop empties. Deliberately no stemming. */
export function tokenize(searchTerm: string): string[] {
  return searchTerm
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

/** Distinct contiguous n-token windows of `tokens`, in first-appearance order. */
export function gramsOf(tokens: string[], n: number): string[] {
  if (n <= 0 || tokens.length < n) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const gram = tokens.slice(i, i + n).join(' ');
    if (!seen.has(gram)) {
      seen.add(gram);
      out.push(gram);
    }
  }
  return out;
}

interface Accumulator {
  gram: string;
  n: number;
  searchTerms: number;
  impressions: number;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
}

/**
 * Aggregate search-term rows into n-gram rows.
 *
 * Rows are sorted by cost descending, then gram ascending, so the output is
 * stable across runs regardless of input order.
 */
export function aggregateNgrams(rows: SearchTermRow[], options: NgramOptions = {}): NgramRow[] {
  const sizes = options.sizes ?? [1, 2, 3];
  const minClicks = options.minClicks ?? 0;
  const acc = new Map<string, Accumulator>();

  for (const row of rows) {
    const tokens = tokenize(row.searchTerm);
    for (const n of sizes) {
      for (const gram of gramsOf(tokens, n)) {
        const key = `${n}\u0000${gram}`;
        let entry = acc.get(key);
        if (!entry) {
          entry = { gram, n, searchTerms: 0, impressions: 0, clicks: 0, cost: 0, purchases: 0, sales: 0 };
          acc.set(key, entry);
        }
        entry.searchTerms += 1;
        entry.impressions += row.impressions;
        entry.clicks += row.clicks;
        entry.cost += row.cost;
        entry.purchases += row.purchases7d;
        entry.sales += row.sales7d;
      }
    }
  }

  const out: NgramRow[] = [];
  for (const entry of acc.values()) {
    if (entry.clicks < minClicks) continue;
    out.push({
      gram: entry.gram,
      n: entry.n,
      searchTerms: entry.searchTerms,
      impressions: entry.impressions,
      clicks: entry.clicks,
      cost: entry.cost,
      purchases: entry.purchases,
      sales: entry.sales,
      ctr: safeDiv(entry.clicks, entry.impressions),
      cvr: safeDiv(entry.purchases, entry.clicks),
      cpc: safeDiv(entry.cost, entry.clicks),
      rpc: safeDiv(entry.sales, entry.clicks),
      acos: safeDiv(entry.cost, entry.sales),
    });
  }
  out.sort((a, b) => (b.cost !== a.cost ? b.cost - a.cost : a.gram < b.gram ? -1 : a.gram > b.gram ? 1 : 0));
  return out;
}

export interface NegativeCandidateOptions {
  targetAcos: number;
  /** Average order value; with `targetAcos` it sets the target CPA threshold. */
  aov: number;
  /** Ignore rows below this click count: one click is not evidence. */
  minClicks?: number;
  /**
   * ACOS ceiling for a converting term. Defaults to the target ACOS itself, so
   * a caller that wants a grace range passes a widened value explicitly rather
   * than inheriting a hidden one.
   */
  acosCeiling?: number;
}

/**
 * Propose negatives from search-term rows.
 *
 * Two reasons, both mathematical rather than arbitrary:
 * - `no_sales_over_target_cpa`: zero purchases with cost past `targetAcos x aov`.
 *   The threshold adapts per product instead of being a flat "$20 and no sales".
 * - `acos_over_ceiling`: converting, but past the ceiling with real click volume.
 */
export function negativeCandidates(
  rows: SearchTermRow[],
  options: NegativeCandidateOptions,
): NegativeCandidate[] {
  const minClicks = options.minClicks ?? 1;
  const targetCpa = options.targetAcos * options.aov;
  const ceiling = options.acosCeiling ?? options.targetAcos;
  const out: NegativeCandidate[] = [];

  for (const row of rows) {
    if (row.clicks < minClicks) continue;
    const acos = safeDiv(row.cost, row.sales7d);
    if (row.purchases7d === 0) {
      if (row.cost > targetCpa) {
        out.push({
          searchTerm: row.searchTerm,
          reason: 'no_sales_over_target_cpa',
          clicks: row.clicks,
          cost: row.cost,
          purchases: row.purchases7d,
          sales: row.sales7d,
          acos,
          threshold: targetCpa,
        });
      }
      continue;
    }
    if (acos !== null && acos > ceiling) {
      out.push({
        searchTerm: row.searchTerm,
        reason: 'acos_over_ceiling',
        clicks: row.clicks,
        cost: row.cost,
        purchases: row.purchases7d,
        sales: row.sales7d,
        acos,
        threshold: ceiling,
      });
    }
  }

  out.sort((a, b) =>
    b.cost !== a.cost ? b.cost - a.cost : a.searchTerm < b.searchTerm ? -1 : a.searchTerm > b.searchTerm ? 1 : 0,
  );
  return out;
}

/** A non-overlapping campaign/ad-group row of the selected gram's evidence. */
export interface NgramNegativeReviewRow {
  campaignId:string; adGroupId:string|null; matchType:'negative_exact'|'negative_phrase'; searchTerms:number;
  spend:number; clicks:number; orders:number; sales:number;
}
export function ngramCoverage(rows:readonly SearchTermRow[],grams:readonly NgramRow[]) {
  const bySize=new Map<number,Set<string>>();
  for(const gram of grams){const set=bySize.get(gram.n)??new Set<string>();set.add(gram.gram);bySize.set(gram.n,set);}
  const represented=rows.filter(row=>{const tokens=tokenize(row.searchTerm);return [...bySize].some(([size,visible])=>gramsOf(tokens,size).some(gram=>visible.has(gram)));});
  return {grams:grams.length,representedTerms:represented.length,totalTerms:rows.length,representedSpend:represented.reduce((n,r)=>n+r.cost,0),totalSpend:rows.reduce((n,r)=>n+r.cost,0)};
}
export function buildNgramNegativeReview(rows:readonly SearchTermRow[],gram:string,n:number,options:NegativeCandidateOptions) {
  const selected=rows.filter(r=>gramsOf(tokenize(r.searchTerm),n).includes(gram));
  const aggregate=aggregateNgrams([...selected],{sizes:[n]}).find(g=>g.gram===gram);
  if(!aggregate||!Number.isFinite(options.targetAcos)||options.targetAcos<=0||!Number.isFinite(options.aov)||options.aov<=0)return null;
  const candidate=negativeCandidates([{searchTerm:gram,impressions:aggregate.impressions,clicks:aggregate.clicks,cost:aggregate.cost,purchases7d:aggregate.purchases,sales7d:aggregate.sales}],options)[0];
  if(!candidate)return null;
  const grouped=new Map<string,NgramNegativeReviewRow>();
  for(const term of selected){if(!term.campaignId)throw new Error('Campaign identity is required');const key=JSON.stringify([term.campaignId,term.adGroupId??null]);
    const row=grouped.get(key)??{campaignId:term.campaignId,adGroupId:term.adGroupId??null,matchType:'negative_phrase',searchTerms:0,spend:0,clicks:0,orders:0,sales:0};
    row.searchTerms++;row.spend+=term.cost;row.clicks+=term.clicks;row.orders+=term.purchases7d;row.sales+=term.sales7d;grouped.set(key,row);}
  const targetCostPerOrder=options.targetAcos*options.aov;
  return {gram,n,candidate,impressions:aggregate.impressions,rows:[...grouped.values()],searchTerms:selected.length,options:{...options},targetCostPerOrder,
    displayedTargetCostPerOrder:Math.round((targetCostPerOrder+Number.EPSILON)*100)/100,spendRatio:aggregate.cost/targetCostPerOrder};
}
export type NgramNegativeReview=NonNullable<ReturnType<typeof buildNgramNegativeReview>>;
/** Existing shared trace contract preserves all engine inputs through queue readback. */
export function ngramCalculationTrace(review:NgramNegativeReview):CalculationTrace {
  const step=(index:number,label:string,formula:string,inputs:CalculationStep['inputs'],result:number|null):CalculationStep=>({index,label,formula,inputs,intermediateValue:result,boundApplied:null,result});
  const steps=[
    step(0,review.candidate.reason,'target ACOS × average order value',[{name:'targetAcos',value:review.options.targetAcos,unit:'ratio'},{name:'averageOrderValue',value:review.options.aov,unit:'currency'},{name:'gram',value:review.gram,unit:'text'},{name:'searchTerms',value:review.searchTerms,unit:'count'}],review.targetCostPerOrder),
    step(1,'Displayed target cost per order','round(target cost per order, 2)',[{name:'targetCostPerOrder',value:review.targetCostPerOrder,unit:'currency'}],review.displayedTargetCostPerOrder),
    step(2,'Spend ratio','spend ÷ unrounded target cost per order',[{name:'spend',value:review.candidate.cost,unit:'currency'},{name:'orders',value:review.candidate.purchases,unit:'count'},{name:'clicks',value:review.candidate.clicks,unit:'count'}],review.spendRatio),
    step(3,'ACOS and ceiling','spend ÷ sales; undefined at zero sales',[{name:'sales',value:review.candidate.sales,unit:'currency'},{name:'ceiling',value:review.options.acosCeiling??review.options.targetAcos,unit:'ratio'}],review.candidate.acos),
  ];
  return {steps,finalResult:steps[3]!.result,roundingStep:steps[1]!};
}
