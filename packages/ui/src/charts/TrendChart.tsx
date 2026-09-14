'use client';

/** Shared token-driven charts and pure geometry. */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatValue } from '../format.js';

export interface TrendPoint {
  date: string;
  value: number | null;
}

export interface TrendSeries {
  label: string;
  points: readonly TrendPoint[];
  scale?: ValueScale;
  mark?: 'line' | 'bar';
  axis?: 'left' | 'right';
}

/**
 * A shaded window drawn behind the lines — WP-19's experiment overlay.
 *
 * A decoration layer, nothing more: it reads the same x-scale the series use and
 * paints a band from `start` to `end` (or to the right edge while `end` is
 * null). It never changes the data, the axis or the series, so a chart with no
 * windows renders exactly as it did before the prop existed.
 */
export interface ChartWindow {
  id?: string;
  label: string;
  start: string;
  end: string | null;
}

export type ValueScale = 'money' | 'percent' | 'ratio' | 'integer';

export type Granularity = 'D' | 'W' | 'M';

export interface TrendChartProps {
  title: string;
  ariaLabel: string;
  series: readonly TrendSeries[];
  scale: ValueScale;
  currencyCode: string;
  caption?: ReactNode;
  header?: ReactNode;
  width?: number;
  height?: number;
  periodAriaLabel?: (index: number) => string;
  periodLabel?: (index: number) => string;
  className?: string;
  /**
   * Show the AdLabs-style daily / weekly / monthly granularity toggle.
   *
   * Only pass `true` for **additive** series (spend, sales, orders, clicks,
   * impressions), because weekly and monthly buckets are computed by *summing*
   * the days inside them. A ratio (ACOS, CPC, CVR) cannot be re-bucketed by
   * summing or averaging its daily values — it would have to be recomputed from
   * base sums, which this component does not carry — so the toggle stays off for
   * those and the chart is daily-only. This is the same discipline the grid's
   * group-by follows (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §4).
   */
  aggregatable?: boolean;
  /**
   * Experiment windows to shade behind the series (WP-19). Additive: omitted or
   * empty means an unchanged chart.
   */
  windows?: readonly ChartWindow[];
  /** Trailing attribution-restatement window, rendered with its own neutral band. */
  settlingWindow?: ChartWindow;
}

const GRANULARITIES: readonly Granularity[] = ['D', 'W', 'M'];
const GRANULARITY_LABEL: Record<Granularity, string> = { D: 'Daily', W: 'Weekly', M: 'Monthly' };

/** Monday of the ISO date's week, as a YYYY-MM-DD label. */
export function weekKey(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay();
  const delta = (day + 6) % 7; // days since Monday
  parsed.setUTCDate(parsed.getUTCDate() - delta);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Re-bucket daily points to weekly or monthly by summing.
 *
 * A bucket with no reported day stays `null`, not zero — the same rule the line
 * itself follows, so a quiet week reads as a gap rather than a floor.
 */
function bucketSeries(
  dates: readonly string[],
  series: readonly TrendSeries[],
  granularity: Granularity,
): { dates: string[]; series: TrendSeries[] } {
  if (granularity === 'D') return { dates: [...dates], series: series.map((s) => ({ ...s, points: [...s.points] })) };
  const keyOf = (date: string): string => (granularity === 'W' ? weekKey(date) : date.slice(0, 7));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const date of dates) {
    const key = keyOf(date);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const bucketed = series.map((entry) => {
    const sums = new Map<string, number | null>();
    entry.points.forEach((point) => {
      const key = keyOf(point.date);
      const running = sums.get(key);
      if (point.value === null) {
        if (!sums.has(key)) sums.set(key, null);
      } else {
        sums.set(key, (running ?? 0) + point.value);
      }
    });
    return { ...entry, points: keys.map((key) => ({ date: key, value: sums.get(key) ?? null })) };
  });
  return { dates: keys, series: bucketed };
}

export const W = 760;
export const H = 230;
export const PAD = { top: 14, right: 78, bottom: 26, left: 62 };
export const PLOT_W = W - PAD.left - PAD.right;
export const PLOT_H = H - PAD.top - PAD.bottom;

/** Categorical slots, in fixed order. Never generated, never cycled. */
const SERIES_STYLES = [
  {
    color: 'var(--wa-viz-1)',
    dashed: false,
    outline: 'var(--wa-viz-1-outline)',
  },
  {
    color: 'var(--wa-viz-2)',
    dashed: false,
    outline: 'transparent',
  },
  {
    color: 'var(--wa-viz-3)',
    dashed: true,
    outline: 'transparent',
  },
  { color: 'var(--wa-viz-4)', dashed: false, outline: 'transparent' },
] as const;

const seriesStyle = (index: number) => SERIES_STYLES[index] ?? SERIES_STYLES[0];

export function TrendChart({
  title,
  ariaLabel,
  series,
  scale,
  currencyCode,
  caption,
  header,
  width = W,
  height = H,
  periodAriaLabel,
  periodLabel,
  className,
  aggregatable = false,
  windows = [],
  settlingWindow,
}: TrendChartProps): ReactNode {
  const W = width;
  const H = height;
  const PLOT_W = W - PAD.left - PAD.right;
  const PLOT_H = H - PAD.top - PAD.bottom;
  const [hover, setHover] = useState<number | null>(null);
  const [gran, setGran] = useState<Granularity>('D');
  const context = useMemo(() => ({ currencyCode, locale: 'en-US' }), [currencyCode]);

  const rawDates = useMemo(() => series[0]?.points.map((point) => point.date) ?? [], [series]);
  const view = useMemo(
    () => bucketSeries(rawDates, series, aggregatable ? gran : 'D'),
    [rawDates, series, aggregatable, gran],
  );
  const dates = view.dates;
  const gseries = view.series;
  const values = gseries.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value): value is number => value !== null),
  );

  const head = header ?? (
    <ChartHead title={title} series={gseries}>
      {aggregatable ? <GranularityToggle value={gran} onChange={setGran} /> : null}
    </ChartHead>
  );

  if (dates.length === 0 || values.length === 0) {
    return (
      <figure className={className} style={{ margin: 0 }}>
        {head}
        <div className="wa-empty" style={{ padding: '2rem 1rem' }}>
          <p className="wa-empty__body">
            No day in this window carried a figure for {title.toLowerCase()}. Amazon omits
            zero-impression rows, so this is either a quiet period or a report that has not landed —
            the freshness banner above says which.
          </p>
        </div>
      </figure>
    );
  }

  const hasBars = gseries.some((entry) => entry.mark === 'bar');
  const step = PLOT_W / Math.max(1, dates.length);
  const x = (index: number): number => hasBars ? PAD.left + step * (index + 0.5)
    : dates.length === 1 ? PAD.left + PLOT_W / 2 : PAD.left + (index / (dates.length - 1)) * PLOT_W;
  const axisTicks = (axis: 'left' | 'right'): number[] => {
    const values = gseries.filter((entry) => (entry.axis ?? 'left') === axis)
      .flatMap((entry) => entry.points.flatMap((point) => point.value === null ? [] : [point.value]));
    return niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  };
  const ticksByAxis = { left: axisTicks('left'), right: axisTicks('right') };
  const axisY = (value: number, axis: 'left' | 'right' = 'left'): number => {
    const ticks = ticksByAxis[axis];
    const low = ticks[0] ?? 0;
    const high = ticks.at(-1) ?? 1;
    return PAD.top + PLOT_H - ((value - low) / (high - low || 1)) * PLOT_H;
  };
  const seriesY = (entry: TrendSeries) => (value: number): number => axisY(value, entry.axis ?? 'left');
  const bars = gseries.filter((entry) => entry.mark === 'bar');
  const barWidth = Math.min(22, Math.max(3, step * 0.66 / Math.max(1, bars.length)));
  const settlingBand =
    settlingWindow === undefined ? null : windowBand(settlingWindow, dates, x, PLOT_W);
  const endpoints = gseries
    .map((entry, seriesIndex) => ({ seriesIndex, last: lastDefined(entry.points) }))
    .filter(
      (entry): entry is { seriesIndex: number; last: { index: number; value: number } } =>
        entry.last !== null,
    );
  const stackedLabelYs = stackEndLabelYs(
    endpoints.map((entry) => axisY(entry.last.value, gseries[entry.seriesIndex]?.axis ?? 'left') + 3.5),
    PAD.top + 8,
    PAD.top + PLOT_H,
  );
  const endLabelY = new Map(
    endpoints.map((entry, index) => [entry.seriesIndex, stackedLabelYs[index] ?? axisY(entry.last.value, gseries[entry.seriesIndex]?.axis ?? 'left') + 3.5]),
  );

  const hovered = hover === null ? null : Math.min(Math.max(hover, 0), dates.length - 1);

  return (
    <figure className={className} style={{ margin: 0 }}>
      {head}

      <div style={{ position: 'relative' }}>
        <svg
          className="wa-chart"
          viewBox={`0 0 ${W} ${H}`}
          role={periodAriaLabel === undefined ? 'img' : 'group'}
          aria-label={ariaLabel}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const local = ((event.clientX - box.left) / box.width) * W;
            const ratio = (local - PAD.left) / PLOT_W;
            setHover(Math.round(ratio * (dates.length - 1)));
          }}
        >
          {/* Background windows sit behind axes, series, and hover marks. */}
          {windows.map((window, index) => {
            const band = windowBand(window, dates, x, PLOT_W);
            if (band === null) return null;
            return (
              <rect
                key={window.id ?? `${window.label}-${index}`}
                data-testid="experiment-window"
                data-window-label={window.label}
                x={band.x}
                y={PAD.top}
                width={band.width}
                height={PLOT_H}
                fill="var(--wa-accent-soft)"
                stroke="var(--wa-accent-border)"
                strokeWidth={1}
              >
                <title>{window.label}</title>
              </rect>
            );
          })}

          {settlingBand === null ? null : (
            <g data-testid="settling-window">
              <rect
                x={settlingBand.x}
                y={PAD.top}
                width={settlingBand.width}
                height={PLOT_H}
                fill="var(--wa-warn-bg)"
                stroke="var(--wa-warn-border)"
                strokeWidth={1}
                opacity={0.45}
              >
                <title>{settlingWindow?.label ?? 'Settling'}</title>
              </rect>
              <text
                x={settlingBand.x + 5}
                y={PAD.top + 11}
                fill="var(--wa-warn-text)"
                fontSize={9}
              >
                settling
              </text>
            </g>
          )}

          {(['left', 'right'] as const).map((axis) => {
            const entries = gseries.filter((entry) => (entry.axis ?? 'left') === axis);
            if (entries.length === 0) return null;
            const scales = new Set(entries.map((entry) => entry.scale ?? scale));
            const axisScale = scales.size === 1 ? entries[0]?.scale ?? scale : null;
            return <g key={axis} aria-label={`${axis} axis`}>
              {ticksByAxis[axis].map((tick) => <g key={tick}>
                {axis === 'left' ? <line x1={PAD.left} x2={PAD.left + PLOT_W}
                  y1={axisY(tick, axis)} y2={axisY(tick, axis)} stroke="var(--wa-viz-grid)" strokeWidth={1} /> : null}
                <text x={axis === 'left' ? PAD.left - 8 : PAD.left + PLOT_W + 8}
                  y={axisY(tick, axis) + 3.5} textAnchor={axis === 'left' ? 'end' : 'start'}
                  fill="var(--wa-viz-ink)" fontSize={12}>
                  {axisScale === null ? formatValue(tick, 'integer', context) : formatValue(tick, axisScale, context)}
                </text>
              </g>)}
            </g>;
          })}

          <line
            x1={PAD.left}
            x2={PAD.left + PLOT_W}
            y1={PAD.top + PLOT_H}
            y2={PAD.top + PLOT_H}
            stroke="var(--wa-viz-axis)"
            strokeWidth={1}
          />

          <text
            x={PAD.left}
            y={H - 8}
            fill="var(--wa-viz-ink)"
            fontSize={12}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {dates[0]}
          </text>
          <text
            x={PAD.left + PLOT_W}
            y={H - 8}
            textAnchor="end"
            fill="var(--wa-viz-ink)"
            fontSize={12}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {dates[dates.length - 1]}
          </text>

          {hovered === null ? null : (
            <line
              x1={x(hovered)}
              x2={x(hovered)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--wa-viz-axis)"
              strokeWidth={1}
            />
          )}

          {gseries.map((entry, index) => {
            const visual = seriesStyle(index);
            const color = visual.color;
            const y = seriesY(entry);
            const path = linePath(entry.points, x, y);
            if (entry.mark === 'bar') return <g key={entry.label} data-series-mark="bar" aria-label={`${entry.label} bars`}>
              {entry.points.map((point, pointIndex) => point.value === null ? null : <rect key={point.date}
                x={x(pointIndex) + (bars.indexOf(entry) - bars.length / 2) * barWidth}
                y={Math.min(y(0), y(point.value))} width={barWidth}
                height={Math.max(1, Math.abs(y(0) - y(point.value)))} rx={1.5} fill={color} opacity={0.82} />)}
            </g>;
            const last = lastDefined(entry.points);
            const labelY = endLabelY.get(index);
            return (
              <g key={entry.label} data-series-mark="line" aria-label={`${entry.label} line`}>
                {path === '' ? null : (
                  <>
                    <path
                      d={path}
                      fill="none"
                      stroke={visual.outline}
                      strokeWidth={4}
                      strokeDasharray={visual.dashed ? '5 4' : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    />
                    <path
                      d={path}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeDasharray={visual.dashed ? '5 4' : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </>
                )}
                {last === null ? null : (
                  <>
                    <circle
                      cx={x(last.index)}
                      cy={y(last.value)}
                      r={6}
                      fill={index === 0 ? visual.outline : 'var(--wa-viz-surface)'}
                    />
                    <circle cx={x(last.index)} cy={y(last.value)} r={4} fill={color} />
                    {labelY === undefined || Math.abs(labelY - (y(last.value) + 3.5)) < 1 ? null : (
                      <line
                        x1={x(last.index) + 5}
                        x2={x(last.index) + 9}
                        y1={y(last.value)}
                        y2={labelY - 3.5}
                        stroke="var(--wa-viz-axis)"
                        strokeWidth={1}
                      />
                    )}
                    <text
                      data-testid={`end-label-${index}`}
                      x={x(last.index) + 10}
                      y={labelY}
                      fill="var(--wa-viz-ink)"
                      fontSize={12}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatValue(last.value, entry.scale ?? scale, context)}
                    </text>
                  </>
                )}
                {hovered === null || entry.points[hovered]?.value == null ? null : (
                  <>
                    <circle
                      cx={x(hovered)}
                      cy={y(entry.points[hovered]?.value ?? 0)}
                      r={5.5}
                      fill={index === 0 ? visual.outline : 'var(--wa-viz-surface)'}
                    />
                    <circle
                      cx={x(hovered)}
                      cy={y(entry.points[hovered]?.value ?? 0)}
                      r={3.5}
                      fill={color}
                    />
                  </>
                )}
              </g>
            );
          })}
          <g aria-label="Chart periods">
            {dates.map((date, index) => <rect key={date} className="wa-cockpit__period-hit" role="img" tabIndex={0}
              aria-label={periodAriaLabel?.(index) ?? `${date}: ${gseries.map((entry) => `${entry.label} ${formatValue(entry.points[index]?.value ?? null, entry.scale ?? scale, context)}`).join(', ')}`}
              x={Math.max(PAD.left, x(index) - step / 2)} y={PAD.top} width={step} height={PLOT_H} fill="transparent"
              onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(null)}
              onKeyDown={(event) => { if (event.key === 'Escape') setHover(null); }} />)}
          </g>
        </svg>

        {hovered === null ? null : (
          <div
            role="presentation"
            style={{
              background: 'var(--wa-surface)',
              border: '1px solid var(--wa-border-strong)',
              borderRadius: 'var(--wa-radius)',
              boxShadow: 'var(--wa-shadow-2)',
              fontSize: 'var(--wa-fs-xs)',
              left: `${(x(hovered) / W) * 100}%`,
              padding: '0.375rem 0.5rem',
              pointerEvents: 'none',
              position: 'absolute',
              top: 0,
              transform: hovered > dates.length / 2 ? 'translateX(-105%)' : 'translateX(10px)',
              whiteSpace: 'nowrap',
            }}
          >
            <div style={{ color: 'var(--wa-text-muted)' }}>{periodLabel?.(hovered) ?? dates[hovered]}</div>
            {gseries.map((entry, index) => (
              <div key={entry.label} className="wa-row" style={{ gap: '0.375rem' }}>
                <span
                  aria-hidden="true"
                  className="wa-chart-key"
                  style={{
                    background: seriesStyle(index).dashed ? 'transparent' : seriesStyle(index).color,
                    borderTop: seriesStyle(index).dashed
                      ? `2px dashed ${seriesStyle(index).color}`
                      : undefined,
                  }}
                />
                {entry.label}
                <strong className="wa-num">
                  {formatValue(entry.points[hovered]?.value ?? null, entry.scale ?? scale, context)}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>

      <figcaption className="wa-hint" style={{ marginTop: '0.25rem' }}>
        {caption ?? ''}
        {settlingBand === null ? null : (
          <span data-testid="settling-note">
            {' '}· Shaded dates are still settling inside Amazon&apos;s 14-day attribution window.
          </span>
        )}
      </figcaption>

      <details style={{ marginTop: '0.5rem' }}>
        <summary className="wa-hint" style={{ cursor: 'pointer' }}>
          Show the numbers
        </summary>
        <div className="wa-tablewrap" style={{ marginTop: '0.5rem', maxHeight: '16rem', overflowY: 'auto' }}>
          <table className="wa-table wa-table--numeric">
            <thead>
              <tr>
                <th scope="col">Date</th>
                {gseries.map((entry) => (
                  <th key={entry.label} scope="col" data-numeric="true">
                    {entry.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((date, index) => (
                <tr key={date}>
                  <td>{date}</td>
                  {gseries.map((entry) => (
                    <td key={entry.label} data-numeric="true">
                      {formatValue(entry.points[index]?.value ?? null, entry.scale ?? scale, context)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function ChartHead({
  title,
  series,
  children,
}: {
  title: string;
  series: readonly TrendSeries[];
  children?: ReactNode;
}): ReactNode {
  return (
    <>
      <div
        className="wa-row"
        style={{ alignItems: 'baseline', gap: '0.75rem', justifyContent: 'space-between' }}
      >
        <h3 className="wa-card__title" style={{ fontSize: 'var(--wa-fs-base)' }}>
          {title}
        </h3>
        {children}
      </div>
      {/* One series needs no legend: the title already names what is plotted. */}
      {series.length < 2 ? null : (
        <ul className="wa-chart-legend" style={{ marginTop: '0.375rem' }}>
          {series.map((entry, index) => (
            <li key={entry.label}>
              <span
                aria-hidden="true"
                className="wa-chart-key"
                style={{
                  background: seriesStyle(index).dashed ? 'transparent' : seriesStyle(index).color,
                  borderTop: seriesStyle(index).dashed
                    ? `2px dashed ${seriesStyle(index).color}`
                    : undefined,
                  boxShadow:
                    index === 0 ? `0 0 0 1px ${seriesStyle(index).outline}` : undefined,
                }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The daily / weekly / monthly toggle, AdLabs' own chart control.
 *
 * A segmented control, not a dropdown: three mutually exclusive options are
 * faster to reach as buttons, and the current granularity is legible without
 * opening anything.
 */
export function GranularityToggle({
  value,
  onChange,
}: {
  value: Granularity;
  onChange: (granularity: Granularity) => void;
}): ReactNode {
  return (
    <div className="wa-seg" role="group" aria-label="Chart granularity">
      {GRANULARITIES.map((granularity) => (
        <button
          key={granularity}
          type="button"
          className="wa-seg__btn"
          aria-pressed={granularity === value}
          aria-label={GRANULARITY_LABEL[granularity]}
          title={GRANULARITY_LABEL[granularity]}
          onClick={() => onChange(granularity)}
        >
          {granularity}
        </button>
      ))}
    </div>
  );
}

/**
 * Where an experiment window sits on the x-axis, or null when it falls entirely
 * outside the plotted date domain. Clamped to the plot and padded by half a step
 * so a single-day window is still a visible band rather than a hairline.
 *
 * At weekly or monthly granularity the axis carries one label per bucket, and a
 * window can fall between two of them — a three-day test inside one week, with
 * the week's own label before it and the next week's after it. The band is then
 * clamped to the bucket the window sits in rather than dropped: a test that ran
 * is a test the chart has to show, and vanishing when the operator switches to
 * W is exactly the case where the eye is looking for it.
 */
export function windowBand(
  window: ChartWindow,
  dates: readonly string[],
  x: (index: number) => number,
  plotWidth: number,
): { x: number; width: number } | null {
  if (dates.length === 0) return null;
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  const startKey = window.start;
  const endKey = window.end ?? last;

  // A label is a bucket *start*, and a weekly or monthly one is shorter than
  // the YYYY-MM-DD a window carries ('2026-08' against '2026-08-17'). Compare
  // each label against the window date truncated to that label's own length, so
  // "the bucket beginning 2026-08 starts before 2026-08-17" is true rather than
  // a string comparison that says the opposite.
  const startsAtOrBefore = (label: string, date: string): boolean =>
    label <= date.slice(0, label.length);

  // Entirely before the first bucket, or entirely after the last one.
  if (!startsAtOrBefore(first, endKey)) return null;
  if (last < startKey.slice(0, last.length)) return null;

  // The bucket the window begins in: the last one starting at or before it.
  // Zero when the window began before the plotted range.
  const lastBucketStartingBefore = (date: string): number => {
    for (let index = dates.length - 1; index >= 0; index -= 1) {
      if (startsAtOrBefore(dates[index] as string, date)) return index;
    }
    return 0;
  };

  const startIndex = lastBucketStartingBefore(startKey);
  // …and the bucket it ends in. Never before the start bucket, so a window that
  // opens and closes between two labels is still one bucket wide.
  const endIndex = Math.max(startIndex, lastBucketStartingBefore(endKey));

  const step = dates.length > 1 ? plotWidth / (dates.length - 1) : plotWidth;
  const pad = step / 2;
  const left = Math.max(PAD.left, x(startIndex) - pad);
  const right = Math.min(PAD.left + plotWidth, x(endIndex) + pad);
  return { x: left, width: Math.max(2, right - left) };
}

/** A gap in the data is a gap in the line, never a straight segment across it. */
export function linePath(
  points: readonly TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let open = false;
  points.forEach((point, index) => {
    if (point.value === null) {
      open = false;
      return;
    }
    parts.push(`${open ? 'L' : 'M'}${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`);
    open = true;
  });
  return parts.join(' ');
}

export function lastDefined(points: readonly TrendPoint[]): { index: number; value: number } | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.value;
    if (value !== null && value !== undefined) return { index, value };
  }
  return null;
}

/**
 * Stack endpoint-label baselines with a minimum gap while keeping them in the
 * plot. Input and output order match, so callers can map positions by series.
 */
export function stackEndLabelYs(
  positions: readonly number[],
  minY: number,
  maxY: number,
  gap = 13,
): number[] {
  if (positions.length === 0) return [];
  const sorted = positions
    .map((y, index) => ({ index, y: Math.min(maxY, Math.max(minY, y)) }))
    .sort((a, b) => a.y - b.y);
  const availableGap = sorted.length <= 1 ? gap : Math.min(gap, (maxY - minY) / (sorted.length - 1));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as { index: number; y: number };
    const current = sorted[index] as { index: number; y: number };
    current.y = Math.max(current.y, previous.y + availableGap);
  }
  const overflow = (sorted[sorted.length - 1]?.y ?? maxY) - maxY;
  if (overflow > 0) {
    for (const entry of sorted) entry.y -= overflow;
  }
  const underflow = minY - (sorted[0]?.y ?? minY);
  if (underflow > 0) {
    for (const entry of sorted) entry.y += underflow;
  }
  const result = Array<number>(positions.length);
  for (const entry of sorted) result[entry.index] = entry.y;
  return result;
}

// ---------------------------------------------------------------------------
// Bid corridor (WP-28)
// ---------------------------------------------------------------------------

/**
 * Axis ticks on round numbers.
 *
 * The alternative — ticks at the data's own extremes — puts labels like
 * `$1,283.41` on a gridline, which reads as a data point rather than as a scale.
 */
export function niceTicks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = max === lo ? lo + 1 : max;
  const raw = (hi - lo) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factors = [1, 2, 2.5, 5, 10];
  let factorIndex = Math.max(0, factors.findIndex((factor) => factor >= normalized));

  while (factorIndex < factors.length) {
    const step = (factors[factorIndex] ?? 10) * magnitude;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let value = start; value <= end + step / 2; value += step) {
      ticks.push(Number(value.toFixed(10)));
    }
    if (ticks.length <= 5) {
      if (ticks.length >= 3) return ticks;
      return [start, Number(((start + end) / 2).toFixed(10)), end];
    }
    factorIndex += 1;
  }

  return [lo, Number(((lo + hi) / 2).toFixed(10)), hi];
}
