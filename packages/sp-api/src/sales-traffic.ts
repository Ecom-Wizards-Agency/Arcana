import { SpRetailRow, type SpReportRow } from '@wizard-ads/shared';
import { finishSpReport, spArray, spJsonDocument, spNumber, spRecord, spString, type SpParseContext } from './report-families.js';
export function parseSalesTraffic(text: string, context: SpParseContext) {
  const body = spJsonDocument(text, context.plan, 'retail');
  const rows: SpReportRow[] = [];
  let sourceRows = 0, parsedRows = 0, refusedRows = 0, complete = true;
  for (const [collection, salesKey, trafficKey, grain] of [
    ['salesAndTrafficByDate', 'salesByDate', 'trafficByDate', 'total'],
    ['salesAndTrafficByAsin', 'salesByAsin', 'trafficByAsin', 'child'],
  ] as const) for (const value of spArray(body[collection])) {
    sourceRows++;
    try {
      const raw = spRecord(value), sales = spRecord(raw[salesKey]), traffic = spRecord(raw[trafficKey]);
      const amount = sales['orderedProductSales'] === undefined ? null : spRecord(sales['orderedProductSales']);
      const currency = amount === null ? null : spString(amount['currencyCode']);
      const date = grain === 'total' ? spString(raw['date']) : context.plan.start;
      if (date !== context.plan.start) throw new Error('Date differs');
      const asin = grain === 'child' ? spString(raw['childAsin']) : null;
      const row = SpRetailRow.parse({ kind: 'retail', key: JSON.stringify([grain, date, currency, asin]), date, grain, asin,
        parentAsin: grain === 'child' ? spString(raw['parentAsin']) : null,
        sales: amount === null ? null : spNumber(amount['amount']), currency,
        units: spNumber(sales['unitsOrdered']), orderItems: spNumber(sales['totalOrderItems']),
        sessions: spNumber(traffic['sessions']), pageViews: spNumber(traffic['pageViews']),
        reportedUnitSessionPercentage: spNumber(traffic['unitSessionPercentage']) });
      if ([row.sales, row.units, row.orderItems, row.sessions, row.pageViews].includes(null)) complete = false;
      rows.push(row); parsedRows++;
    } catch { refusedRows++; }
  }
  if (rows.filter(row => row.kind === 'retail' && row.grain === 'total').length === 0 && sourceRows > 0) complete = false;
  return finishSpReport(text, context, rows, { sourceRows, parsedRows, refusedRows }, complete);
}
