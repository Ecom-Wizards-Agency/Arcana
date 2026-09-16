import { SpAbaRow, type SpAbaRow as AbaRow } from '@wizard-ads/shared';
import { finishSpReport, spArray, spJsonDocument, spNumber, spRecord, spString, type SpParseContext } from './report-families.js';
export function parseAbaSearchTerms(text: string, context: SpParseContext) {
  const body = spJsonDocument(text, context.plan, 'aba');
  const groups = new Map<string, AbaRow[]>();
  let sourceRows = 0, parsedRows = 0, refusedRows = 0;
  for (const value of spArray(body['dataByDepartmentAndSearchTerm'])) {
    sourceRows++;
    try {
      const r = spRecord(value), department = spString(r['departmentName']), query = spString(r['searchTerm']);
      const slot = spNumber(r['clickShareRank']);
      if (slot === null || slot < 1) throw new Error('Missing slot');
      const groupKey = JSON.stringify([department, query]);
      const row = SpAbaRow.parse({ kind: 'aba', key: JSON.stringify([department, query, slot]), date: context.plan.start, end: context.plan.end,
        department, query, frequencyRank: spNumber(r['searchFrequencyRank']), slot, asin: spString(r['clickedAsin']),
        clickShare: spNumber(r['clickShare']), conversionShare: spNumber(r['conversionShare']), complete: false, conflicted: false });
      const group = groups.get(groupKey) ?? []; group.push(row); groups.set(groupKey, group); parsedRows++;
    } catch { refusedRows++; }
  }
  const rows: AbaRow[] = [];
  let complete = refusedRows === 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    const known = new Map(group.map(row => [row.slot, row]));
    const conflicts = new Set(group.filter(r => JSON.stringify(r) !== JSON.stringify(known.get(r.slot))).map(r => r.slot));
    const valid = known.size === 3 && new Set([...known.values()].map(r => r.asin)).size === 3
      && group.every(r => r.frequencyRank === first.frequencyRank && r.clickShare !== null && r.conversionShare !== null)
      && group.every(r => JSON.stringify(r) === JSON.stringify(known.get(r.slot)));
    complete &&= valid;
    rows.push({ ...first, slot: 0, key: JSON.stringify([first.department, first.query, 0]), asin: null,
      clickShare: null, conversionShare: null, complete: valid && refusedRows === 0 });
    rows.push(...group.map(r => ({ ...r, conflicted: conflicts.has(r.slot), complete: valid && refusedRows === 0 })));
  }
  return finishSpReport(text, context, rows, { sourceRows, parsedRows, refusedRows, addedRows: groups.size }, complete);
}
