import type { ReactNode } from 'react';

export function HomeCard({ title, subtitle, children, className = '' }: {
  title: string; subtitle: string; children: ReactNode; className?: string;
}) {
  return <section className={`wa-home-card ${className}`} aria-label={title}>
    <header><h2>{title}</h2><p>{subtitle}</p></header>{children}
  </section>;
}
