// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TrendChart } from './TrendChart.js';

afterEach(cleanup);
it('retains each series mark, scale and axis when additive days become weeks', () => {
  const points = [{ date: '2026-04-01', value: 10 }, { date: '2026-04-02', value: 20 }];
  const expectedWeeks = ['2026-03-30'];
  const series = [{ label: 'Spend', points, mark: 'bar' as const, axis: 'right' as const, scale: 'money' as const }];
  const { container } = render(<TrendChart title="Spend" ariaLabel="Spend trend" series={series}
    scale="integer" currencyCode="USD" aggregatable />);
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
  expect(container.querySelectorAll('[data-series-mark="bar"] rect')).toHaveLength(expectedWeeks.length);
  expect(container.querySelector('[aria-label="right axis"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="left axis"]')).toBeNull();
  fireEvent.click(screen.getByText('Show the numbers'));
  expect(screen.getByRole('cell', { name: '$30.00' })).toBeTruthy();
});


it('places rank 1 above worse ranks, preserves gaps and keeps positive tooltips', () => {
  const points = [
    { date: '2026-06-01', value: 1 }, { date: '2026-06-02', value: null },
    { date: '2026-06-03', value: 1000 }, { date: '2026-06-04', value: 1500 },
  ];
  const { container } = render(<TrendChart title="Rank" ariaLabel="BSR" series={[{ label: 'Own', points }]}
    scale="integer" currencyCode="USD" invertedAxis />);
  const axis = container.querySelector('[aria-label="left axis"]')!;
  const labels = [...axis.querySelectorAll('text')];
  expect(labels[0]?.textContent).toBe('1');
  expect(container.querySelectorAll('[data-isolated-rank]')).toHaveLength(1);
  expect(Number(labels[0]?.getAttribute('y'))).toBeLessThan(Number(labels.at(-1)?.getAttribute('y')));
  const paths = [...container.querySelectorAll('[data-series-mark="line"] path')];
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) expect(path.getAttribute('d')?.match(/M/g)).toHaveLength(2);
  fireEvent.click(screen.getByText('Show the numbers'));
  expect(screen.getByRole('cell', { name: '1,500' })).toBeTruthy();
  expect(screen.queryByRole('cell', { name: '-1,500' })).toBeNull();
});

it('renders named rank endpoints, a dashed threshold and a dated alert window without a legend', () => {
  const points = [{ date: '2026-06-01', value: 1000 }, { date: '2026-06-02', value: null }, { date: '2026-06-03', value: 1042 }];
  const { container } = render(<TrendChart title="Rank" ariaLabel="BSR" header={<></>} series={[
    { label: 'You', points, tone: 'own' },
    { label: 'alert threshold', tone: 'threshold', points: points.map((point) => ({ ...point, value: point.value === null ? null : Math.floor(point.value * 1.15) })) },
  ]} scale="integer" currencyCode="USD" invertedAxis rankLabels showNumbers={false}
    windows={[{ label: 'alert fires 3 Jun', start: '2026-06-03', end: null }]} />);
  expect(container.querySelector('[aria-label="left axis"] text')?.textContent).toBe('#1');
  expect(container.querySelector('[data-testid="end-label-0"]')?.textContent).toBe('You #1,042');
  expect(container.querySelector('[data-testid="end-label-1"]')?.textContent).toBe('alert threshold #1,198');
  expect(container.querySelector('[aria-label="alert threshold line"] path[stroke-dasharray]')).not.toBeNull();
  expect(container.querySelector('[data-testid="experiment-window"] title')?.textContent).toBe('alert fires 3 Jun');
  expect(container.querySelector('details')).toBeNull();
  for (const path of container.querySelectorAll('[data-series-mark="line"] path')) expect(path.getAttribute('d')?.match(/M/g)).toHaveLength(2);
});

it('draws dated boundaries and outside margins without event shading, and keeps named end labels',()=>{
  const points=[{date:'2026-08-01',value:1},{date:'2026-08-02',value:2},{date:'2026-08-03',value:3},{date:'2026-08-04',value:4}];
  const clicks:string[]=[];
  render(<TrendChart title="Timeline" ariaLabel="Timeline" series={[{label:'Spend',points}]} scale="money" currencyCode="USD" namedEndLabels
    focusWindow={{id:'event',label:'Synthetic event',start:'2026-08-02',end:'2026-08-03'}} eventMarkers={[{id:'event',label:'Synthetic event',start:'2026-08-02',end:null}]} onEventClick={(id)=>clicks.push(id)}/>);
  expect(screen.queryAllByTestId('experiment-window')).toHaveLength(0);expect(screen.getAllByTestId('outside-event-window')).toHaveLength(2);
  expect(screen.getAllByTestId('event-marker').map((marker)=>marker.getAttribute('data-date'))).toEqual(['2026-08-02','2026-08-04']);
  fireEvent.keyDown(screen.getByRole('button',{name:'Synthetic event: running'}),{key:'Enter'});expect(clicks).toEqual(['event']);expect(screen.getByTestId('end-label-0').textContent).toContain('Spend');
});

it('limits crowded boundary labels to two rows and reveals shorter markers on focus', () => {
  render(<TrendChart title="Spend" ariaLabel="Crowded events" scale="money" currencyCode="USD" width={400}
    series={[{label:'Spend',points:[{date:'2026-08-01',value:1},{date:'2026-08-31',value:2}]}]}
    eventMarkers={[
      {id:'short',label:'Short',start:'2026-08-01',end:'2026-08-02'},
      {id:'long',label:'Long',start:'2026-08-01',end:'2026-08-31'},
      {id:'medium',label:'Medium',start:'2026-08-01',end:'2026-08-20'},
    ]} onEventClick={() => {}} />);
  const markers = screen.getAllByTestId('event-marker');
  expect(markers.every((marker) => ['-1','0','1'].includes(marker.getAttribute('data-label-lane')!))).toBe(true);
  const shorter = screen.getByRole('button',{name:'Short: 1 Aug'});
  expect(shorter.querySelector('[data-testid="event-marker-label"]')).toBeNull();
  expect(screen.getByRole('button',{name:'Long: 1 Aug'}).querySelector('[data-testid="event-marker-label"]')).not.toBeNull();
  fireEvent.focus(shorter);
  expect(shorter.querySelector('[data-testid="event-marker-label"]')).not.toBeNull();
  fireEvent.blur(shorter);
  expect(shorter.querySelector('[data-testid="event-marker-label"]')).toBeNull();
});
