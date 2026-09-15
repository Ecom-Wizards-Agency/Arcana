import type { ReactNode } from 'react';
type DataProps = { [key: `data-${string}`]: string | undefined };

export function EmptyState({
  variant = 'empty',
  title,
  body,
  meta,
  action,
  ...rest
}: {
  variant?: 'empty' | 'not-measured' | 'gated' | 'loading' | 'error';
  title: string;
  body: ReactNode;
  /** Timestamp or result context that distinguishes a completed empty run. */
  meta?: ReactNode;
  action?: ReactNode;
} & DataProps): ReactNode {
  return (
    <div {...rest} className="wa-empty" data-state={variant} aria-busy={variant === 'loading' ? true : undefined} role={variant === 'error' ? 'alert' : variant === 'loading' ? 'status' : undefined}>
      <p className="wa-empty__title">{title}</p>
      <p className="wa-empty__body">{body}</p>
      {meta === undefined ? null : <p className="wa-empty__meta">{meta}</p>}
      {action}
    </div>
  );
}
