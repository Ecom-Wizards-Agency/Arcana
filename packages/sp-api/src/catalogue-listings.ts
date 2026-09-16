import { SpListingRow, type SpReportRow } from '@wizard-ads/shared';
import { SpApiParseError } from './errors.js';
import { finishSpReport, validateSpPlan, type SpParseContext } from './report-families.js';

/** TSV supports quoted tabs/newlines and doubled quotes. Unterminated fields fail closed. */
function tsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; } else field += c;
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === '\t') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++; row.push(field); rows.push(row); row = []; field = ''; closed = false;
    } else { if (closed || c === '"') throw new SpApiParseError('Malformed quoted TSV'); field += c; }
  }
  if (quoted) throw new SpApiParseError('Truncated quoted TSV');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}
export function parseCatalogueListings(text: string, context: SpParseContext) {
  validateSpPlan(context.plan);
  if (context.plan.family !== 'catalogue') throw new SpApiParseError('Catalogue family mismatch');
  const observed = new Date(context.observedAt);
  if (!Number.isFinite(observed.getTime()) || observed.toISOString().slice(0, 10) !== context.plan.start)
    throw new SpApiParseError('Catalogue inventory observation differs from requested day');
  const [header, ...source] = tsv(text.replace(/^\uFEFF/, ''));
  if (!header || new Set(header).size !== header.length || !['listing-id', 'seller-sku', 'asin1'].every(k => header.includes(k))) throw new SpApiParseError('Unsupported listing headers');
  const rows: SpReportRow[] = []; let parsedRows = 0, refusedRows = 0;
  for (const values of source) {
    try {
      if (values.length !== header.length) throw new SpApiParseError('Truncated listing row');
      const raw = Object.fromEntries(header.map((k, i) => [k, values[i]!]));
      const fields: Record<string, string | number> = {};
      for (const [from, to] of [['item-name', 'title'], ['item-description', 'description'], ['image-url', 'imageUrl'], ['status', 'status'], ['item-condition', 'condition']] as const)
        if (raw[from] !== undefined && raw[from] !== '') fields[to] = raw[from];
      if (raw['quantity'] !== undefined && raw['quantity'] !== '') {
        if (!/^\d+$/.test(raw['quantity'])) throw new SpApiParseError('Invalid quantity'); fields['quantity'] = Number(raw['quantity']);
      }
      rows.push(SpListingRow.parse({ kind: 'catalogue', key: JSON.stringify([raw['listing-id'], raw['seller-sku'], raw['asin1']]),
        date: context.plan.start, listingId: raw['listing-id'], sku: raw['seller-sku'], asin: raw['asin1'], fields })); parsedRows++;
    } catch { refusedRows++; }
  }
  return finishSpReport(text, context, rows, { sourceRows: source.length, parsedRows, refusedRows }, refusedRows === 0);
}
