'use client';
import { useState } from 'react';
import { CAMPAIGN_AD_TYPE_SNAPSHOT, spMarketplaceBidCapability, type CampaignBuilderAdType, type CampaignBuilderContext } from '@wizard-ads/shared';
import { Button, Input, Select, Notice, money } from './ui';

export function AdTypeCards({ context, selected, onSelect }: { context: CampaignBuilderContext; selected: CampaignBuilderAdType; onSelect: (type: CampaignBuilderAdType) => void }) {
  const bidRules = spMarketplaceBidCapability(context.profile.marketplace ?? undefined);
  return <section className="wa-stack"><h2>Choose the ad type first</h2><p className="wa-hint">What you can set differs by type, so the form changes rather than showing fields that will be ignored.</p><div className="campaign-ad-types" data-capability-version={CAMPAIGN_AD_TYPE_SNAPSHOT.version}>
    {CAMPAIGN_AD_TYPE_SNAPSHOT.entries.map(({ adType, name, cost, rows, source }) => <Button key={adType} aria-pressed={adType === selected} onClick={() => onSelect(adType)} title={source} className="campaign-ad-type" style={{ background: adType === selected ? 'var(--wa-accent-soft)' : 'var(--wa-surface-2)', borderColor: adType === selected ? 'var(--wa-accent)' : 'var(--wa-border)' }}>
      <strong>{name}</strong><p className="wa-hint">{adType} · {cost}</p>
      {rows.map((row) => <div key={row.label} className="wa-hint"><span style={{ color: row.supported ? 'var(--wa-good-text)' : 'var(--wa-text-dim)' }}>{row.supported ? '✓' : '—'}</span> {row.label}</div>)}
    </Button>)}
  </div><p className="wa-hint">These lists come from a versioned capability snapshot, not from memory. Amazon changes what a type supports, and an old help article is not current API authority — a control we cannot verify is shown as unavailable rather than offered and then rejected on push.</p><small className="wa-hint">Snapshot {CAMPAIGN_AD_TYPE_SNAPSHOT.version}{selected === 'SP' ? bidRules ? ` · Marketplace bids: ${money(bidRules.bidMin, bidRules.currencyCode)} to ${money(bidRules.bidMax, bidRules.currencyCode)} · ${bidRules.decimalPlaces} decimal places` : ' · Marketplace bid limits: not measured' : ''}</small></section>;
}
export function Products({ context, selected, onSelect }: { context: CampaignBuilderContext; selected: string[]; onSelect: (keys: string[]) => void }) {
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all');
  const products = context.products.filter((product) => `${product.name} ${product.asin} ${product.sku ?? ''}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || product.state === filter));
  return <section className="wa-stack"><h2>Choose products</h2><div className="wa-actions"><Input aria-label="Search products" placeholder="Search products or SKU" value={search} onChange={(event) => setSearch(event.target.value)} /><Select aria-label="Product state filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All mirrored products</option><option value="enabled">Enabled product ads</option><option value="paused">Paused product ads</option></Select></div>
    {!products.length ? <Notice>No advertised products match. Sync products or adjust the filters.</Notice> : products.map((product) => <label key={product.key} style={{ display: 'flex', gap: 12, padding: 12, borderBottom: '1px solid var(--wa-border)' }}><input type="checkbox" checked={selected.includes(product.key)} onChange={() => onSelect(selected.includes(product.key) ? selected.filter((key) => key !== product.key) : [...selected, product.key])} /><span><strong>{product.name}</strong><br /><span className="wa-hint">{product.asin} · {product.sku ?? 'SKU not measured'} · {product.state}</span></span></label>)}
    <p className="wa-hint">{selected.length} selected · Source: advertised-product mirror. Stock, Buy Box and suppression are not measured.</p></section>;
}
