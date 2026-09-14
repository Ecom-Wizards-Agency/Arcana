import type { ReactNode } from 'react';
import styles from './optimizer.module.css';

export function OptimizerFrame({ title, subtitle, step, children }: { title: string; subtitle?: string; step?: 1 | 2 | 3; children: ReactNode }) {
  return <main className={styles.page}>
    <p className={styles.breadcrumb}>Arcana / {title}</p>
    <header><h1>{title}</h1>{subtitle ? <p className={styles.muted}>{subtitle}</p> : null}</header>
    {step ? <ol className={styles.steps} aria-label="Optimization progress">
      {['Choose campaigns', 'Review suggestions', 'Confirm and results'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>{index + 1}. {label}</li>)}
    </ol> : null}
    {children}
  </main>;
}

export function OptimizerUnavailable({ title = 'Optimize Now', message }: { title?: string; message: string }) {
  return <OptimizerFrame title={title}><p role="status">{message}</p><a href="/settings/connections">Review connections</a></OptimizerFrame>;
}
