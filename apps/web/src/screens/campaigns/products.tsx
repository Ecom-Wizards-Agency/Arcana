'use client';
import { useState } from 'react';
import { spMarketplaceBidCapability, type CampaignBuilderAdType, type CampaignBuilderContext } from '@wizard-ads/shared';
import { Button, Input, Select, Notice, money } from './ui';

const adTypes = [ ['SP', 'Sponsored Products', 'CPC'], ['SB', 'Sponsored Brands', 'CPC'], ['SBV', 'Sponsored Brands video', 'CPC'], ['SD', 'Sponsored Display', 'CPC or vCPM'] ] as const;
const controls = [['target_bid', 'Keyword bids'], ['placement_adjustment', 'Placement adjustments'], ['audience_adjustment', 'Audience adjustments'], ['bidding_mode', 'Bidding strategy']] as const;
export function AdTypeCards({ context, selected, onSelect }: { context: CampaignBuilderContext; selected: CampaignBuilderAdType; onSelect: (type: CampaignBuilderAdType) => void }) {
  const bidRules = spMarketplaceBidCapability(context.profile.marketplace ?? undefined);
  return <section className="wa-stack"><h2>Choose the ad type first</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 }}>
    {adTypes.map(([type, title, cost]) => <Button key={type} aria-pressed={type === selected} onClick={() => onSelect(type)} style={{ display: 'block', textAlign: 'left', whiteSpace: 'normal', fontWeight: 400, lineHeight: 1.5, padding: 16, borderColor: type === selected ? 'var(--wa-accent)' : 'var(--wa-border)' }}>
      <strong>{title}</strong><p className="wa-hint">{type} · {cost}</p>
      {controls.map(([control, label]) => {
        const available = type === 'SP' && (control !== 'target_bid' || bidRules !== null) && context.capabilities.entries.some((entry) => entry.adProduct === 'SP' && entry.control === control && entry.available);
        return <div key={control}>{available ? '✓' : '—'} {label}{available ? '' : ' · Unavailable'}</div>;
      })}
      {type === 'SP' && <p className="wa-hint">{bidRules ? `Marketplace bids: ${money(bidRules.bidMin, bidRules.currencyCode)} to ${money(bidRules.bidMax, bidRules.currencyCode)} · ${bidRules.decimalPlaces} decimal places` : 'Marketplace bid limits: not measured'}</p>}
    </Button>)}
  </div><p className="wa-hint">These lists come from capability snapshot {context.capabilities.version}. A control we cannot verify is unavailable.</p></section>;
}
export function Products({ context, selected, onSelect }: { context: CampaignBuilderContext; selected: string[]; onSelect: (keys: string[]) => void }) {
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all');
  const products = context.products.filter((product) => `${product.name} ${product.asin} ${product.sku ?? ''}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || product.state === filter));
  return <section className="wa-stack"><h2>Choose products</h2><div className="wa-actions"><Input aria-label="Search products" placeholder="Search products or SKU" value={search} onChange={(event) => setSearch(event.target.value)} /><Select aria-label="Product state filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All mirrored products</option><option value="enabled">Enabled product ads</option><option value="paused">Paused product ads</option></Select></div>
    {!products.length ? <Notice>No advertised products match. Sync products or adjust the filters.</Notice> : products.map((product) => <label key={product.key} style={{ display: 'flex', gap: 12, padding: 12, borderBottom: '1px solid var(--wa-border)' }}><input type="checkbox" checked={selected.includes(product.key)} onChange={() => onSelect(selected.includes(product.key) ? selected.filter((key) => key !== product.key) : [...selected, product.key])} /><span><strong>{product.name}</strong><br /><span className="wa-hint">{product.asin} · {product.sku ?? 'SKU not measured'} · {product.state}</span></span></label>)}
    <p className="wa-hint">{selected.length} selected · Source: advertised-product mirror. Stock, Buy Box and suppression are not measured.</p></section>;
}
