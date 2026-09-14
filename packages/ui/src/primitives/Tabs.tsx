'use client';
import { useId } from 'react';
import type { ReactNode } from 'react';

export interface StateTabItem { value: string; label: string; panel?: ReactNode }
export interface TabsProps {
  items: readonly StateTabItem[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  /** Caller-owned query state; unrelated parameters are preserved. */
  searchParams?: string;
  onSearchParamsChange?: (query: string) => void;
}

export function tabFromSearchParams(query: string, fallback: string): string {
  return new URLSearchParams(query).get('tab') ?? fallback;
}

export function Tabs({ items, value, onValueChange, ariaLabel, searchParams, onSearchParamsChange }: TabsProps): ReactNode {
  const id = useId();
  const select = (next: string): void => {
    onValueChange(next);
    if (onSearchParamsChange !== undefined) {
      const params = new URLSearchParams(searchParams);
      params.set('tab', next);
      onSearchParamsChange(params.toString());
    }
  };
  return <>
    <div role="tablist" aria-label={ariaLabel} className="wa-tabs">
      {items.map((item, index) => <button key={item.value} type="button" role="tab"
        className="wa-tab" id={`${id}-tab-${index}`} aria-selected={value === item.value}
        aria-controls={`${id}-panel-${index}`} tabIndex={value === item.value ? 0 : -1}
        onClick={() => select(item.value)} onKeyDown={(event) => {
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : event.key === 'ArrowRight' ? (index + 1) % items.length
              : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : null;
          if (next === null) return;
          event.preventDefault();
          const target = items[next];
          if (target === undefined) return;
          select(target.value);
          (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
        }}>{item.label}</button>)}
    </div>
    {items.map((item, index) => <div key={item.value} role="tabpanel" id={`${id}-panel-${index}`}
      aria-labelledby={`${id}-tab-${index}`} hidden={value !== item.value}>{item.panel}</div>)}
  </>;
}
