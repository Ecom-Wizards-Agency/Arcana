import { CampaignCreationPlan, orderCampaignCreationNodes } from '@wizard-ads/shared';
import { AMAZON_BIDDING, AMAZON_MATCH, SP_COLUMNS } from './constants.js';
import { toUpdateBulkWorkbook } from './export.js';
import type { BulkRow } from './types.js';

/** Export only the frozen resource values. No current mirror or naming defaults enter this projection. */
export function creationPlanToBulkWorkbook(raw: CampaignCreationPlan) {
  const plan = CampaignCreationPlan.parse(raw);
  if (plan.adProduct !== 'SP' || plan.apiDialect !== 'sp_legacy_v3') throw new Error('Bulk export supports the reviewed Sponsored Products format only');
  const nodes = orderCampaignCreationNodes(plan.nodes);
  const rows: BulkRow[] = [];
  const empty = () => ({ ...Object.fromEntries(SP_COLUMNS.map((column) => [column, ''])), Product: 'Sponsored Products', Operation: 'Create' }) as BulkRow;
  const temporary = (id: string) => `tmp-${id}`;
  const campaigns = nodes.filter((node) => node.kind === 'campaign.create');
  for (const campaign of campaigns) {
    if (campaign.payload.settings.product !== 'SP') throw new Error('Campaign settings do not match the ad type');
    const schedule = 'schedule' in campaign.payload ? campaign.payload.schedule : { type: 'calendar_dates' as const, startDate: campaign.payload.startDate, endDate: campaign.payload.endDate };
    if (schedule.type !== 'calendar_dates') throw new Error('SP export requires calendar dates');
    const common = { 'Campaign ID': temporary(campaign.nodeId), 'Campaign Name': campaign.payload.name };
    const settings = campaign.payload.settings;
    const bidding = { manual: AMAZON_BIDDING['Fixed bids'], legacy_for_sales: AMAZON_BIDDING['Down only'], auto_for_sales: AMAZON_BIDDING['Up and down'], rule_based: null }[settings.biddingStrategy];
    if (bidding === null) throw new Error('Rule-based creation is unavailable for bulk export');
    rows.push({ ...empty(), ...common, Entity: 'Campaign', State: campaign.payload.state, 'Daily Budget': campaign.payload.budget.amount,
      'Start Date': schedule.startDate.replaceAll('-', ''), 'End Date': schedule.endDate?.replaceAll('-', '') ?? '', 'Targeting Type': settings.targetingType.toUpperCase(),
      'Bidding Strategy': bidding, 'Portfolio ID': campaign.payload.portfolioId ?? '' });
    for (const [key, label] of [['topOfSearch','Placement Top'],['restOfSearch','Placement Rest Of Search'],['productPages','Placement Product Page']] as const) {
      if (settings.placementBidding[key] !== 0) rows.push({ ...empty(), ...common, Entity: 'Bidding Adjustment', Placement: label, Percentage: settings.placementBidding[key] });
    }
    const groups = nodes.filter((node) => node.kind === 'ad_group.create' && node.payload.campaign.nodeId === campaign.nodeId);
    for (const group of groups) {
      if (group.kind !== 'ad_group.create') continue;
      const groupCommon = { ...common, 'Ad Group ID': temporary(group.nodeId), 'Ad Group Name': group.payload.name };
      rows.push({ ...empty(), ...groupCommon, Entity: 'Ad Group', State: group.payload.state, 'Ad Group Default Bid': group.payload.defaultBid ?? '' });
      for (const node of nodes) {
        if (node.kind === 'ad.create' && node.payload.adGroup.nodeId === group.nodeId) {
          if (node.payload.format !== 'sp_product_ad') throw new Error('Unsupported ad format in frozen export');
          const productId = node.payload.product.nodeId;
          const product = nodes.find((item) => item.nodeId === productId);
          if (product?.kind !== 'eligibility.require_product') throw new Error('Frozen product is unavailable');
          rows.push({ ...empty(), ...groupCommon, Entity: 'Product Ad', State: node.payload.state, SKU: product.payload.sku ?? '', ASIN: product.payload.asin });
        }
        if (node.kind === 'target.create' && node.payload.parent.nodeId === group.nodeId) {
          if (node.payload.targetType !== 'keyword' || node.payload.polarity !== 'positive') throw new Error('Unsupported target format in frozen export');
          const match = { exact: AMAZON_MATCH.EXACT, phrase: AMAZON_MATCH.PHRASE, broad: AMAZON_MATCH.BROAD,
            negative_exact: undefined, negative_phrase: undefined }[node.payload.matchType];
          if (match === undefined) throw new Error('Bulk keyword match type is unavailable');
          rows.push({ ...empty(), ...groupCommon, Entity: 'Keyword', State: node.payload.state, 'Keyword Text': node.payload.text, 'Match Type': match, Bid: node.payload.bid ?? '' });
        }
      }
    }
  }
  if (rows.filter((row) => row.Entity !== 'Bidding Adjustment').length !== plan.counts.irreversibleCreates) throw new Error('Frozen export resource counts do not reconcile');
  const workbook = toUpdateBulkWorkbook(rows, { client: 'campaign-draft', marketplace: plan.marketplaceId, today: plan.generatedAt.slice(0,10) });
  return { ...workbook, filename: 'campaign-draft.xlsx' };
}
