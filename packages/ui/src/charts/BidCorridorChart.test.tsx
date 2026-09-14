// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BidCorridorChart } from './BidCorridorChart.js';
const points = [{date:'2026-08-01',low:4,median:8,high:11,bid:5,cpc:2,maxCpc:10,components:[]}];
it('hides selected lines and endpoint values without substituting zero',()=>{
  const {container}=render(<BidCorridorChart currencyCode="USD" ariaLabel="Synthetic corridor" points={points} visible={{suggested:false,maxCpc:false}} />);
  expect(container.querySelector('[data-testid="corridor-band"]')).toBeNull();
  expect(container.querySelector('svg')?.textContent).not.toContain('$8.00');
  expect(container.querySelector('svg')?.textContent).toContain('$5.00');
  expect(container.querySelector('tbody')?.textContent).not.toContain('$0.00');
});
it('keeps gaps between measured suggested bands',()=>{
  const {container}=render(<BidCorridorChart currencyCode="USD" ariaLabel="Synthetic corridor" points={[...points,{...points[0]!,date:'2026-08-02',low:null,median:null,high:null},{...points[0]!,date:'2026-08-03'}]} />);
  expect(container.querySelectorAll('[data-testid="corridor-band"]')).toHaveLength(2);
});

it('names compact endpoint labels and separates coincident values', () => {
  const {container} = render(<BidCorridorChart compact currencyCode="USD" ariaLabel="Synthetic corridor" points={[{...points[0]!,median:5,cpc:5,maxCpc:5}]} />);
  const labels = Array.from(container.querySelectorAll('svg text')).filter((label) => /^(Suggested|Max CPC|CPC|Bid) /.test(label.textContent ?? ''));
  expect(labels).toHaveLength(4);
  expect(new Set(labels.map((label) => label.getAttribute('y'))).size).toBe(4);
});

it('retains placement exposure when only the base bid line is hidden', () => {
  const {container} = render(<BidCorridorChart currencyCode="USD" ariaLabel="Synthetic corridor" points={[{...points[0]!,components:[{name:'Top of search',pct:100}]}]} visible={{bid:false}} placementLines={['Top of search']} />);
  expect(container.querySelector('path[aria-label="Top of search exposure"]')).not.toBeNull();
});
