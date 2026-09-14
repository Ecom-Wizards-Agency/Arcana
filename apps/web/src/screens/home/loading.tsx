import { HomeCard } from './card';
import './home.css';

export default function HomeLoading() {
  return <main className="wa-home" aria-busy="true" data-testid="dashboard-loading">
    <section className="wa-home-kpis" aria-label="Loading performance summary">{['Spend', 'Sales', 'ACOS', 'Orders', 'Break-even ACOS'].map((title) =>
      <div className="wa-home-kpi wa-home-skeleton" key={title}><span>{title}</span><small>Loading…</small></div>)}</section>
    <div className="wa-home-grid">{['Proposals', 'Flags', 'Pacing', 'Rank watch', 'Campaigns near their limit', 'Market position'].map((title) =>
      <HomeCard title={title} subtitle="Loading current account performance and decisions…" key={title}><div className="wa-home-skeleton" /></HomeCard>)}</div>
  </main>;
}
