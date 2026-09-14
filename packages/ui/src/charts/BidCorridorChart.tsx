'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { formatValue } from '../format.js';
import { W, H, PAD, PLOT_W, PLOT_H, weekKey, linePath, lastDefined, niceTicks, GranularityToggle, type Granularity, type TrendPoint } from './TrendChart.js';

/** One target's corridor on one day: the market band and the plotted lines. */
export interface BidCorridorPoint {
  date: string;
  /** Amazon's suggested-bid corridor edges and midpoint. Null where none synced. */
  low: number | null;
  median: number | null;
  high: number | null;
  /** The bid in force (a step function), realized CPC, and max-potential CPC. */
  bid: number | null;
  cpc: number | null;
  maxCpc: number | null;
  /** The modifiers that composed `maxCpc`, in application order. */
  components: readonly { name: string; pct: number }[];
}

export interface BidCorridorChartProps {
  /**
   * Omit when the surrounding card header already names the chart. Passing the
   * card's own heading through renders it twice, which is what the optimizer
   * did with "Bid corridor" whenever no target was selected.
   */
  title?: string;
  ariaLabel: string;
  currencyCode: string;
  points: readonly BidCorridorPoint[];
  caption?: string;
  /** Show the corridor's daily / weekly / monthly projection. */
  aggregatable?: boolean;
}

/** The corridor's series, in the rail order the recon fixes (§3). */
const CORRIDOR_COLORS = {
  suggested: 'var(--wa-viz-2)', // orange — Amazon Suggested (band + median)
  bid: 'var(--wa-viz-4)', // secondary indigo — Bid (step)
  cpc: 'var(--wa-viz-1)', // Electric Indigo — realized CPC
  maxCpc: 'var(--wa-viz-5)', // neutral comparison — Max CPC (dashed step)
} as const;

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

/**
 * Aggregate a daily corridor without pretending its band is additive.
 *
 * The band preserves every daily edge (minimum low, maximum high), while its
 * midpoint and the plotted bid/CPC lines are means. Modifier components are
 * intentionally daily-only: an averaged placement stack never existed on any
 * one day and would make the tooltip look more exact than it is.
 */
export function aggregateBidCorridorPoints(
  points: readonly BidCorridorPoint[],
  granularity: Granularity,
): BidCorridorPoint[] {
  if (granularity === 'D') return points.map((point) => ({ ...point }));
  const keyOf = (date: string): string =>
    granularity === 'W' ? weekKey(date) : date.slice(0, 7);
  const buckets = new Map<string, BidCorridorPoint[]>();
  for (const point of points) {
    const key = keyOf(point.date);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [point]);
    else bucket.push(point);
  }
  const edge = (
    bucket: readonly BidCorridorPoint[],
    field: 'low' | 'high',
    choose: (values: readonly number[]) => number,
  ): number | null => {
    const values = bucket
      .map((point) => point[field])
      .filter((value): value is number => value !== null);
    return values.length === 0 ? null : choose(values);
  };
  return [...buckets.entries()].map(([date, bucket]) => ({
    date,
    low: edge(bucket, 'low', (values) => Math.min(...values)),
    median: mean(bucket.map((point) => point.median)),
    high: edge(bucket, 'high', (values) => Math.max(...values)),
    bid: mean(bucket.map((point) => point.bid)),
    cpc: mean(bucket.map((point) => point.cpc)),
    maxCpc: mean(bucket.map((point) => point.maxCpc)),
    components: [],
  }));
}

/**
 * The bid corridor drill-down (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/04-optimizer.md` §3).
 *
 * Amazon's daily suggested-bid low↔high drawn as a filled orange band with a
 * dashed median through it — market evidence, not policy — and over it the
 * target's bid (a secondary-indigo step, because a bid only moves when moved),
 * realized CPC (Electric Indigo), and max-potential CPC (a dashed neutral
 * step). The whole point
 * is to put Amazon's *external* opinion next to our *internal* one and let the
 * operator see the gap: a bid at the corridor floor while CPC runs above its
 * ceiling is a placement-modifier problem, and only this chart shows both.
 *
 * Additive to `TrendChart`: it reuses the same geometry, tokens, hover discipline
 * and table-under-every-chart rule, and adds the band and the step marks the
 * corridor needs. The hover tooltip lists, for the crosshair's day, the Max CPC
 * with its modifier components indented beneath it, then the suggested band, CPC
 * and Bid — the rail's own order, so the composition reads without a sentence.
 */
export function BidCorridorChart({
  title,
  ariaLabel,
  currencyCode,
  points,
  caption,
  aggregatable = false,
}: BidCorridorChartProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const [gran, setGran] = useState<Granularity>('D');
  const context = useMemo(() => ({ currencyCode, locale: 'en-US' }), [currencyCode]);
  const viewPoints = useMemo(
    () => aggregateBidCorridorPoints(points, aggregatable ? gran : 'D'),
    [aggregatable, gran, points],
  );

  const dates = viewPoints.map((point) => point.date);
  const values = viewPoints.flatMap((point) =>
    [point.low, point.median, point.high, point.bid, point.cpc, point.maxCpc].filter(
      (value): value is number => value !== null && value !== undefined,
    ),
  );

  const legend = (
    <ul className="wa-chart-legend" style={{ marginTop: '0.375rem' }}>
      {[
        { label: 'Amazon Suggested', color: CORRIDOR_COLORS.suggested },
        { label: 'Bid', color: CORRIDOR_COLORS.bid },
        { label: 'CPC', color: CORRIDOR_COLORS.cpc },
        { label: 'Max CPC', color: CORRIDOR_COLORS.maxCpc },
      ].map((entry) => (
        <li key={entry.label}>
          <span
            aria-hidden="true"
            className="wa-chart-key"
            style={{
              background: entry.color,
              boxShadow:
                entry.color === CORRIDOR_COLORS.cpc ? '0 0 0 1px var(--wa-viz-1-outline)' : undefined,
            }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );

  const head = (
    <>
      {title === undefined && !aggregatable ? null : (
        <div className="wa-row" style={{ alignItems: 'baseline', gap: '0.75rem', justifyContent: 'space-between' }}>
          {title === undefined ? <span /> : (
            <h3 className="wa-card__title" style={{ fontSize: 'var(--wa-fs-base)' }}>
              {title}
            </h3>
          )}
          {aggregatable ? (
            <GranularityToggle
              value={gran}
              onChange={(value) => {
                setHover(null);
                setGran(value);
              }}
            />
          ) : null}
        </div>
      )}
      {legend}
    </>
  );

  if (dates.length === 0 || values.length === 0) {
    return (
      <figure style={{ margin: 0 }} data-testid="bid-corridor-empty">
        {head}
        <div className="wa-empty" style={{ padding: '2rem 1rem' }}>
          <p className="wa-empty__body">
            No bid corridor has been synced for this target yet. The daily sync retrieves Amazon&apos;s
            suggested-bid band and stores it as a series; until it runs there is nothing to draw here.
          </p>
        </div>
      </figure>
    );
  }

  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const ticks = niceTicks(min, max);
  const top = ticks[ticks.length - 1] ?? 1;
  const bottom = ticks[0] ?? 0;
  const span = top - bottom || 1;

  const x = (index: number): number =>
    dates.length === 1 ? PAD.left + PLOT_W / 2 : PAD.left + (index / (dates.length - 1)) * PLOT_W;
  const y = (value: number): number => PAD.top + PLOT_H - ((value - bottom) / span) * PLOT_H;

  const hovered = hover === null ? null : Math.min(Math.max(hover, 0), dates.length - 1);

  const bandPaths = corridorBandSegments(viewPoints, x, y);
  const medianPath = linePath(viewPoints.map((p) => ({ date: p.date, value: p.median })), x, y);
  const cpcPath = linePath(viewPoints.map((p) => ({ date: p.date, value: p.cpc })), x, y);
  const bidPath = stepPath(viewPoints.map((p) => ({ date: p.date, value: p.bid })), x, y);
  const maxCpcPath = stepPath(viewPoints.map((p) => ({ date: p.date, value: p.maxCpc })), x, y);

  return (
    <figure style={{ margin: 0 }} data-testid="bid-corridor">
      {head}

      <div style={{ position: 'relative' }}>
        <svg
          className="wa-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const local = ((event.clientX - box.left) / box.width) * W;
            const ratio = (local - PAD.left) / PLOT_W;
            setHover(Math.round(ratio * (dates.length - 1)));
          }}
        >
          {/* The corridor band, painted first so every line sits over it. */}
          {bandPaths.map((d, index) => (
            <path
              key={`band-${index}`}
              data-testid="corridor-band"
              d={d}
              fill={CORRIDOR_COLORS.suggested}
              fillOpacity={0.16}
              stroke="none"
            />
          ))}

          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(tick)} y2={y(tick)} stroke="var(--wa-viz-grid)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(tick) + 3.5} textAnchor="end" fill="var(--wa-viz-ink)" fontSize={12} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatValue(tick, 'money', context)}
              </text>
            </g>
          ))}

          <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={PAD.top + PLOT_H} y2={PAD.top + PLOT_H} stroke="var(--wa-viz-axis)" strokeWidth={1} />
          <text x={PAD.left} y={H - 8} fill="var(--wa-viz-ink)" fontSize={12} style={{ fontVariantNumeric: 'tabular-nums' }}>{dates[0]}</text>
          <text x={PAD.left + PLOT_W} y={H - 8} textAnchor="end" fill="var(--wa-viz-ink)" fontSize={12} style={{ fontVariantNumeric: 'tabular-nums' }}>{dates[dates.length - 1]}</text>

          {hovered === null ? null : (
            <line x1={x(hovered)} x2={x(hovered)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="var(--wa-viz-axis)" strokeWidth={1} />
          )}

          {/* Median: dashed, in the band's own hue. */}
          {medianPath === '' ? null : (
            <path d={medianPath} fill="none" stroke={CORRIDOR_COLORS.suggested} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {/* Max CPC: a dashed neutral step, often above everything on a modifier day. */}
          {maxCpcPath === '' ? null : (
            <path d={maxCpcPath} fill="none" stroke={CORRIDOR_COLORS.maxCpc} strokeWidth={2} strokeDasharray="2 3" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {/* CPC: exact Electric Indigo with a contrast outline in dark mode. */}
          {cpcPath === '' ? null : (
            <>
              <path
                d={cpcPath}
                fill="none"
                stroke="var(--wa-viz-1-outline)"
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              />
              <path d={cpcPath} fill="none" stroke={CORRIDOR_COLORS.cpc} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </>
          )}
          {/* Bid: a solid secondary-indigo step; it only moves when somebody moves it. */}
          {bidPath === '' ? null : (
            <path d={bidPath} fill="none" stroke={CORRIDOR_COLORS.bid} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          )}

          <CorridorEndpointLabels points={points} x={x} y={y} context={context} />

          {hovered === null ? null : (
            <CorridorHoverDots point={viewPoints[hovered]} index={hovered} x={x} y={y} />
          )}
        </svg>

        {hovered === null || viewPoints[hovered] === undefined ? null : (
          <CorridorTooltip point={viewPoints[hovered] as BidCorridorPoint} left={(x(hovered) / W) * 100} flip={hovered > dates.length / 2} context={context} />
        )}
      </div>

      <figcaption className="wa-hint" style={{ marginTop: '0.25rem' }}>{caption ?? ''}</figcaption>

      <details style={{ marginTop: '0.5rem' }}>
        <summary className="wa-hint" style={{ cursor: 'pointer' }}>Show the numbers</summary>
        <div className="wa-tablewrap" style={{ marginTop: '0.5rem', maxHeight: '16rem', overflowY: 'auto' }}>
          <table className="wa-table wa-table--numeric">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" data-numeric="true">Low</th>
                <th scope="col" data-numeric="true">Median</th>
                <th scope="col" data-numeric="true">High</th>
                <th scope="col" data-numeric="true">Bid</th>
                <th scope="col" data-numeric="true">CPC</th>
                <th scope="col" data-numeric="true">Max CPC</th>
              </tr>
            </thead>
            <tbody>
              {viewPoints.map((point) => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td data-numeric="true">{formatValue(point.low, 'money', context)}</td>
                  <td data-numeric="true">{formatValue(point.median, 'money', context)}</td>
                  <td data-numeric="true">{formatValue(point.high, 'money', context)}</td>
                  <td data-numeric="true">{formatValue(point.bid, 'money', context)}</td>
                  <td data-numeric="true">{formatValue(point.cpc, 'money', context)}</td>
                  <td data-numeric="true">{formatValue(point.maxCpc, 'money', context)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** The hover crosshair's per-series dots, with a contrast ring for exact indigo. */
function CorridorHoverDots({
  point,
  index,
  x,
  y,
}: {
  point: BidCorridorPoint | undefined;
  index: number;
  x: (index: number) => number;
  y: (value: number) => number;
}): ReactNode {
  if (point === undefined) return null;
  const dots: Array<{ value: number | null; color: string; ring?: string }> = [
    { value: point.median, color: CORRIDOR_COLORS.suggested },
    { value: point.maxCpc, color: CORRIDOR_COLORS.maxCpc },
    { value: point.cpc, color: CORRIDOR_COLORS.cpc, ring: 'var(--wa-viz-1-outline)' },
    { value: point.bid, color: CORRIDOR_COLORS.bid },
  ];
  return (
    <>
      {dots.map((dot, i) =>
        dot.value === null ? null : (
          <g key={i}>
            <circle
              cx={x(index)}
              cy={y(dot.value)}
              r={5.5}
              fill={dot.ring ?? 'var(--wa-viz-surface)'}
            />
            <circle cx={x(index)} cy={y(dot.value)} r={3.5} fill={dot.color} />
          </g>
        ),
      )}
    </>
  );
}

/** The corridor tooltip: rail order, Max CPC's modifiers indented beneath it. */
function CorridorTooltip({
  point,
  left,
  flip,
  context,
}: {
  point: BidCorridorPoint;
  left: number;
  flip: boolean;
  context: { currencyCode: string; locale: string };
}): ReactNode {
  const money = (value: number | null): string => formatValue(value, 'money', context);
  return (
    <div
      role="presentation"
      data-testid="corridor-tooltip"
      style={{
        background: 'var(--wa-surface)',
        border: '1px solid var(--wa-border-strong)',
        borderRadius: 'var(--wa-radius)',
        boxShadow: 'var(--wa-shadow-2)',
        fontSize: 'var(--wa-fs-xs)',
        left: `${left}%`,
        padding: '0.375rem 0.5rem',
        pointerEvents: 'none',
        position: 'absolute',
        top: 0,
        transform: flip ? 'translateX(-105%)' : 'translateX(10px)',
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ color: 'var(--wa-text-muted)' }}>{point.date}</div>
      <TooltipRow label="Max CPC" color={CORRIDOR_COLORS.maxCpc} value={money(point.maxCpc)} />
      {point.components.map((component) => (
        <div key={component.name} className="wa-row" style={{ gap: '0.375rem', paddingLeft: '0.85rem' }}>
          <span style={{ color: 'var(--wa-text-muted)' }}>{component.name}</span>
          <strong className="wa-num">{component.pct >= 0 ? '+' : ''}{component.pct}%</strong>
        </div>
      ))}
      <TooltipRow label="Amazon Suggested" color={CORRIDOR_COLORS.suggested} value={`${money(point.high)} / ${money(point.median)} / ${money(point.low)}`} />
      <TooltipRow label="CPC" color={CORRIDOR_COLORS.cpc} value={money(point.cpc)} />
      <TooltipRow label="Bid" color={CORRIDOR_COLORS.bid} value={money(point.bid)} />
    </div>
  );
}

function TooltipRow({ label, color, value }: { label: string; color: string; value: string }): ReactNode {
  return (
    <div className="wa-row" style={{ gap: '0.375rem' }}>
      <span aria-hidden="true" className="wa-chart-key" style={{ background: color }} />
      {label}
      <strong className="wa-num">{value}</strong>
    </div>
  );
}

/** Endpoint values keep the corridor readable without requiring a hover target. */
function CorridorEndpointLabels({
  points,
  x,
  y,
  context,
}: {
  points: readonly BidCorridorPoint[];
  x: (index: number) => number;
  y: (value: number) => number;
  context: { currencyCode: string; locale: string };
}): ReactNode {
  const endpoints = [
    { points: points.map((point) => ({ date: point.date, value: point.median })), offset: -12 },
    { points: points.map((point) => ({ date: point.date, value: point.maxCpc })), offset: 14 },
    { points: points.map((point) => ({ date: point.date, value: point.cpc })), offset: 2 },
    { points: points.map((point) => ({ date: point.date, value: point.bid })), offset: 14 },
  ];
  return (
    <>
      {endpoints.map((entry, index) => {
        const endpoint = lastDefined(entry.points);
        if (endpoint === null) return null;
        return (
          <text
            key={index}
            x={x(endpoint.index) + 10}
            y={y(endpoint.value) + entry.offset}
            fill="var(--wa-viz-ink)"
            fontSize={12}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatValue(endpoint.value, 'money', context)}
          </text>
        );
      })}
    </>
  );
}

/**
 * Contiguous filled segments between the corridor's low and high edges. A band
 * breaks wherever either edge has no value for the day, the same rule the lines
 * follow, so a gap in the sync reads as a gap in the band rather than a bridge.
 */
export function corridorBandSegments(
  points: readonly BidCorridorPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
  const segments: string[] = [];
  let run: { index: number; low: number; high: number }[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      // A lone day is a hairline; widen it a touch so it is still visible.
      const only = run[0];
      if (only !== undefined) {
        const cx = x(only.index);
        segments.push(`M${(cx - 1).toFixed(2)} ${y(only.high).toFixed(2)} L${(cx + 1).toFixed(2)} ${y(only.high).toFixed(2)} L${(cx + 1).toFixed(2)} ${y(only.low).toFixed(2)} L${(cx - 1).toFixed(2)} ${y(only.low).toFixed(2)} Z`);
      }
    } else {
      const top = run.map((p) => `${x(p.index).toFixed(2)} ${y(p.high).toFixed(2)}`);
      const bottom = [...run].reverse().map((p) => `${x(p.index).toFixed(2)} ${y(p.low).toFixed(2)}`);
      segments.push(`M${top.join(' L')} L${bottom.join(' L')} Z`);
    }
    run = [];
  };
  points.forEach((point, index) => {
    if (point.low === null || point.high === null) {
      flush();
      return;
    }
    run.push({ index, low: point.low, high: point.high });
  });
  flush();
  return segments;
}

/**
 * A step path: a value holds until the next reported day, then jumps. A bid and
 * a max-potential CPC are both step functions — they change only when a lever
 * moves — so a straight interpolation between two days would draw a change that
 * never happened. Gaps break the line exactly as `linePath` does.
 */
export function stepPath(
  points: readonly TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let open = false;
  let prevY: number | null = null;
  points.forEach((point, index) => {
    if (point.value === null) {
      open = false;
      prevY = null;
      return;
    }
    const px = x(index);
    const py = y(point.value);
    if (!open) {
      parts.push(`M${px.toFixed(2)} ${py.toFixed(2)}`);
    } else if (prevY !== null) {
      // Horizontal to this x at the previous height, then a vertical step.
      parts.push(`L${px.toFixed(2)} ${prevY.toFixed(2)} L${px.toFixed(2)} ${py.toFixed(2)}`);
    }
    open = true;
    prevY = py;
  });
  return parts.join(' ');
}

