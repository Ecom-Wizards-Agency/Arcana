'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { BidHistoryPayload } from '../../app/_lib/bid-corridor';
import { bidHistoryKpiTiles } from '../optimizer/view';
import { KpiTile } from './dashboard';
import { BidCorridorChart } from '@wizard-ads/ui';
import { Target360 } from '../screens/targets/target360';
import type { Target360Model } from '../screens/targets/model';

export interface BidHistoryModalProps {
  profileId: string;
  targetId: string;
  window: { start: string; end: string };
  currencyCode: string;
  onClose: () => void;
}

function focusable(dialog: HTMLDivElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** Shared target analysis and staged bid review over the originating grid. */
export function BidHistoryModal({
  profileId,
  targetId,
  window: dateWindow,
  currencyCode,
  onClose,
}: BidHistoryModalProps): ReactNode {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; payload: BidHistoryPayload; model: Target360Model }
  >({ status: 'loading' });
  const [origin] = useState(() => typeof window !== 'undefined' && window.location.pathname === '/grid' ? `${window.location.pathname}${window.location.search}` : '/grid');
  const returnLocation = useRef(origin);
  const close = useCallback(() => {
    window.history.replaceState(window.history.state, '', returnLocation.current);
    onClose();
  }, [onClose]);
  useEffect(() => {
    const preserve = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
      const url = new URL(origin, window.location.origin);
      url.searchParams.set('view', event.detail);
      returnLocation.current = `${url.pathname}${url.search}`;
    };
    window.addEventListener('arcana:target-view', preserve);
    return () => window.removeEventListener('arcana:target-view', preserve);
  }, [origin]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [close]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      profile: profileId,
      target: targetId,
      from: dateWindow.start,
      to: dateWindow.end,
    });
    setState({ status: 'loading' });
    void (async () => {
      try {
        const path = `/api/targets/${encodeURIComponent(targetId)}`;
        const response = await fetch(`${path}?${query.toString()}`, {
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | (Target360Model & { error?: never })
          | { error?: string }
          | null;
        if (!response.ok || payload === null || !('payload' in payload)) {
          throw new Error(
            (payload !== null && 'error' in payload ? payload.error : null) ??
              `Bid history failed to load (${response.status})`,
          );
        }
        setState({ status: 'ready', payload: payload.payload, model: payload });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Bid history failed to load',
        });
      }
    })();
    return () => controller.abort();
  }, [dateWindow.end, dateWindow.start, profileId, targetId]);

  useEffect(() => {
    if (state.status === 'ready') dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close target"]')?.focus();
  }, [state.status]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || dialogRef.current === null) return;
    const controls = focusable(dialogRef.current);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const payload = state.status === 'ready' ? state.payload : null;
  const title =
    payload === null
      ? 'Bid history'
      : `${payload.target.targeting}${
          payload.target.matchType === null ? '' : ` · ${payload.target.matchType}`
        }`;
  const campaignHref = useMemo(() => {
    if (payload === null) return null;
    const query = new URLSearchParams({
      profile: profileId,
      entity: 'campaigns',
      campaign: payload.target.campaignId,
      from: dateWindow.start,
      to: dateWindow.end,
    });
    return `/grid?${query.toString()}`;
  }, [dateWindow.end, dateWindow.start, payload, profileId]);

  const dismissBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close();
  };

  return (
    <div className="wa-modal-backdrop" onMouseDown={dismissBackdrop}>
      <div
        ref={dialogRef}
        className="wa-bid-history-modal"
        role="dialog"
        aria-modal="true"
        aria-label={state.status === 'ready' ? title : undefined}
        aria-labelledby={state.status === 'ready' ? undefined : 'bid-history-title'}
        aria-describedby={state.status === 'ready' ? undefined : 'bid-history-subtitle'}
        onKeyDown={trapFocus}
      >
        {state.status !== 'ready' ? <header className="wa-bid-history-modal__head">
          <div style={{ minWidth: 0 }}>
            <h2 id="bid-history-title" className="wa-bid-history-modal__title" title={title}>
              {title}
            </h2>
            <p id="bid-history-subtitle" className="wa-bid-history-modal__sub">
              {payload === null ? (
                `${dateWindow.start} to ${dateWindow.end}`
              ) : (
                <>
                  {payload.target.adProduct} | {payload.target.targetKind} |{' '}
                  {campaignHref === null ? payload.target.campaignName : (
                    <a href={campaignHref}>{payload.target.campaignName} ↗</a>
                  )}
                  {' · '}{payload.window.from} to {payload.window.to}
                </>
              )}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="wa-btn wa-btn--ghost"
            aria-label="Close bid history"
            onClick={close}
          >
            ✕
          </button>
        </header> : null}

        <div className="wa-bid-history-modal__body">
          {state.status === 'loading' ? (
            <div className="wa-bid-history-modal__loading" role="status" aria-busy="true">
              Loading bid history…
            </div>
          ) : state.status === 'error' ? (
            <div className="wa-empty" role="alert">
              <h3 className="wa-empty__title">Bid history unavailable</h3>
              <p className="wa-empty__body">{state.message}</p>
            </div>
          ) : (
            <Target360 model={state.model} currencyCode={currencyCode} back={origin} savedView={new URL(origin, window.location.origin).searchParams.get('view')} onClose={close} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared metrics and corridor for the drawer and the full target page. */
export function BidHistoryContent({ payload, currencyCode }: { payload: BidHistoryPayload; currencyCode: string }): ReactNode {
  return (
            <>
              <section aria-label="Target metrics" className="wa-kpis wa-kpis--dense">
                {bidHistoryKpiTiles(payload.totals).map((tile) => (
                  <KpiTile
                    key={tile.metric}
                    label={tile.label}
                    value={tile.value}
                    scale={tile.scale}
                    better={tile.better}
                    delta={{ caption: 'vs prior period', pct: null, reference: null }}
                    context={{ currencyCode, locale: 'en-US' }}
                  />
                ))}
              </section>

              <section className="wa-card wa-bid-history-modal__chart" aria-label="Bid corridor chart">
                <BidCorridorChart
                  title="Bid corridor"
                  ariaLabel="Amazon suggested-bid corridor with bid, CPC and max potential CPC"
                  currencyCode={currencyCode}
                  points={payload.points}
                  aggregatable
                  caption={`Suggested-bid band, bid, realized CPC and max potential CPC. In ${currencyCode}.`}
                />
              </section>
            </>
  );
}
