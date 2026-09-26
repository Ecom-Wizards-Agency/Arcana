'use client';
import { useState } from 'react';

export interface HomeRankRow {
  asin: string;
  keyword: string;
  currentRank: number | null;
  previousRank: number | null;
  movement: number | null;
  spend: number | null;
}

export const RANK_WATCH_TOP = 5;

export function productHref(asin: string, profileId: string): string {
  return `/grid?${new URLSearchParams({ profile: profileId, entity: 'products', asin })}`;
}

/** Rows arrive ordered by the size of the weekly move; the first five show until expanded. */
export function RankWatchList({ ranks, profileId, currencyCode }: {
  ranks: readonly HomeRankRow[]; profileId: string; currencyCode: string;
}) {
  const money = (value: number | null) => value === null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: currencyCode });
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? ranks : ranks.slice(0, RANK_WATCH_TOP);
  const hidden = ranks.length - RANK_WATCH_TOP;
  return <>
    <ul className="wa-home-ranks" aria-label="Rank movements">{shown.map((row) => <li key={`${row.asin}-${row.keyword}`} data-tone={row.movement === null || row.movement === 0 ? 'neutral' : row.movement > 0 ? 'good' : 'warn'}>
      <div><strong>{row.keyword}</strong>
        <p><a className="wa-home-rank-product" href={productHref(row.asin, profileId)} aria-label={`Open product ${row.asin}`}>{row.asin}</a>
          {' · '}{row.movement === null ? 'Weekly change not measured' : row.movement === 0 ? 'Unchanged this week' : `${row.movement > 0 ? 'Climbing' : 'Slipping'} · ${row.movement > 0 ? 'Up' : 'Down'} ${Math.abs(row.movement)} places`}</p></div>
      <strong className="wa-home-rank-value">{row.currentRank === null ? '—' : `#${row.currentRank}`}{row.previousRank === null ? '' : ` ← #${row.previousRank}`}</strong>
      <span className="wa-home-rank-spend" title="Ad spend attributable to this product and keyword" aria-label="Keyword spend">{money(row.spend)}</span>
    </li>)}</ul>
    {hidden > 0 ? <button className="wa-btn wa-btn--ghost wa-btn--sm wa-home-more" type="button" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show top 5' : `View more (${hidden.toLocaleString('en-US')})`}</button> : null}
  </>;
}
