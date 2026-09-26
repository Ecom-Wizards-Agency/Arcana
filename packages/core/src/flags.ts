/**
 * Port of `flags.py`: severity-tagged, goal-aware performance flags.
 *
 * The part of this module that matters most is the part that does NOT fire.
 * A wide ACOS swing on a Rank/SKW campaign is a last-click attribution
 * artifact, not an anomaly, so it is returned in a separate `suppressed` list:
 * visible as "noted, not flagged", never silently dropped and never raised as
 * an alert. Everything else here is ordinary thresholding.
 *
 * The default thresholds and the goal-lens presets below are the reference
 * toolkit's own published defaults, not tenant doctrine. Tenant doctrine
 * (target ACOS, change caps, search-volume bands) never appears in this
 * repository; it arrives at runtime through `config`.
 */
import { formatFixed, formatMoney } from './num.js';
import { addDays } from './rows.js';
import {
  CATEGORY_DISCOVERY,
  CATEGORY_RANK,
  CATEGORY_UNKNOWN,
  type AnalysisResult,
  type DailyRow,
  type Flag,
  type SeriesAnalysis,
  type Severity,
} from './types.js';

export const SEVERITY_CRITICAL: Severity = 'critical';
export const SEVERITY_ALERT: Severity = 'alert';
export const SEVERITY_WARN: Severity = 'warn';
export const SEVERITY_INFO: Severity = 'info';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  alert: 1,
  warn: 2,
  info: 3,
};
const SEVERITY_LADDER: Severity[] = [SEVERITY_CRITICAL, SEVERITY_ALERT, SEVERITY_WARN, SEVERITY_INFO];

export interface Thresholds {
  spend_spike_pct: number;
  spend_collapse_pct: number;
  cvr_drop_pct: number;
  clicks_stable_band_pct: number;
  near_zero_impressions_abs: number;
  near_zero_impressions_ratio: number;
  discovery_share_max: number;
  acos_swing_pct: number;
  zero_sales_spend_min: number;
  budget_capped_min_days: number;
  tacos_rise_alert_pct: number;
  margin_drop_alert_pct: number;
  /*
   * Evidence floor, one pair per flag family. A signal whose evaluation window
   * holds fewer impressions or fewer days of data than its family's floor is
   * not raised; `evaluate` returns it in `floored` so the caller can count it.
   * Impression floors apply to campaign-scoped signals only: an account total
   * is the sum of every campaign, and an account-totals feed may carry no
   * impressions at all. The account-level families therefore have days only.
   */
  floor_spend_spike_min_impressions: number;
  floor_spend_spike_min_days: number;
  floor_spend_collapse_min_impressions: number;
  floor_spend_collapse_min_days: number;
  floor_budget_capped_min_impressions: number;
  floor_budget_capped_min_days: number;
  floor_cvr_drop_min_impressions: number;
  floor_cvr_drop_min_days: number;
  floor_near_zero_impressions_min_impressions: number;
  floor_near_zero_impressions_min_days: number;
  floor_zero_sales_spend_min_impressions: number;
  floor_zero_sales_spend_min_days: number;
  floor_acos_swing_min_impressions: number;
  floor_acos_swing_min_days: number;
  floor_discovery_share_min_days: number;
  floor_tacos_margin_min_days: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  spend_spike_pct: 0.6,
  spend_collapse_pct: -0.5,
  cvr_drop_pct: -0.25,
  clicks_stable_band_pct: 0.15,
  near_zero_impressions_abs: 50,
  near_zero_impressions_ratio: 0.15,
  discovery_share_max: 0.2,
  acos_swing_pct: 0.5,
  zero_sales_spend_min: 20.0,
  budget_capped_min_days: 1,
  tacos_rise_alert_pct: 0.2,
  margin_drop_alert_pct: -0.15,
  // Engineering floors, not doctrine: the least evidence on which a
  // trailing-week comparison says anything. The window is the report day plus
  // the seven days before it, so eight days is full coverage.
  floor_spend_spike_min_impressions: 100,
  floor_spend_spike_min_days: 3,
  floor_spend_collapse_min_impressions: 100,
  floor_spend_collapse_min_days: 3,
  floor_budget_capped_min_impressions: 100,
  floor_budget_capped_min_days: 1,
  floor_cvr_drop_min_impressions: 200,
  floor_cvr_drop_min_days: 3,
  floor_near_zero_impressions_min_impressions: 100,
  floor_near_zero_impressions_min_days: 3,
  floor_zero_sales_spend_min_impressions: 100,
  floor_zero_sales_spend_min_days: 3,
  floor_acos_swing_min_impressions: 200,
  floor_acos_swing_min_days: 3,
  floor_discovery_share_min_days: 1,
  floor_tacos_margin_min_days: 3,
};

export type TacosMarginBehavior = 'expected_high' | 'alert_on_rise' | 'ignore';

/** Pacing knobs a lens may nudge; `pacing.ts` owns their defaults. */
export interface PacingOverrides {
  warn_above?: number;
  act_above?: number;
  underpace_below?: number;
}

export interface GoalLens {
  label: string;
  description: string;
  threshold_overrides: Partial<Thresholds>;
  tacos_margin_behavior: TacosMarginBehavior;
  impression_rank_critical: boolean;
  escalate_spend_spike?: boolean;
  downgrade_zero_sales?: boolean;
  pacing_overrides?: PacingOverrides;
}

export const GOAL_RANK_LAUNCH = 'rank-launch';
export const GOAL_SCALE = 'scale';
export const GOAL_PROFIT_MAINTAIN = 'profit-maintain';
export const GOAL_DEFEND = 'defend';
export const GOAL_MAINTAIN = 'maintain';
export const GOAL_LIQUIDATE = 'liquidate';
export const GOAL_INACTIVE = 'inactive';
export const GOAL_NEUTRAL = 'neutral';
export const DEFAULT_GOAL = GOAL_NEUTRAL;

export const GOAL_LENSES: Record<string, GoalLens> = {
  [GOAL_RANK_LAUNCH]: {
    label: 'Rank / Launch',
    description:
      'Building organic rank on a new/young ASIN. High or rising TACOS/ACOS is the plan, ' +
      'not a problem -- the real emergency is losing impression share on the Rank keyword ' +
      "we're trying to rank.",
    threshold_overrides: { tacos_rise_alert_pct: 0.35, acos_swing_pct: 0.75 },
    tacos_margin_behavior: 'expected_high',
    impression_rank_critical: true,
    pacing_overrides: { warn_above: 1.2, act_above: 1.4 },
  },
  [GOAL_SCALE]: {
    label: 'Scale',
    description:
      'Proven winner, pushing volume. Efficiency matters more than at launch but growth ' +
      'still leads -- watch discovery bloat and CVR more closely than raw ACOS/TACOS.',
    threshold_overrides: { discovery_share_max: 0.15 },
    tacos_margin_behavior: 'ignore',
    impression_rank_critical: false,
  },
  [GOAL_PROFIT_MAINTAIN]: {
    label: 'Profit / Maintain',
    description:
      'Mature ASIN, defending margin. Rising TACOS or falling margin IS the alert; ' +
      'aggressive spend growth is the flag, not expected upside.',
    threshold_overrides: {
      tacos_rise_alert_pct: 0.15,
      margin_drop_alert_pct: -0.1,
      spend_spike_pct: 0.35,
    },
    tacos_margin_behavior: 'alert_on_rise',
    impression_rank_critical: false,
    escalate_spend_spike: true,
    pacing_overrides: { warn_above: 1.05, act_above: 1.15 },
  },
  [GOAL_DEFEND]: {
    label: 'Defend',
    description:
      'Protecting rank/share against a competitor or hijacker push. Near-zero impressions ' +
      'and Shield-category anomalies are urgent; some extra spend to hold position is expected.',
    threshold_overrides: { tacos_rise_alert_pct: 0.25, near_zero_impressions_ratio: 0.25 },
    tacos_margin_behavior: 'alert_on_rise',
    impression_rank_critical: true,
  },
  [GOAL_MAINTAIN]: {
    label: 'Maintain / Stability',
    description:
      'Keep the account steady with no surprises (e.g. offboarding client, caretaker mode). ' +
      'Any sharp move -- spend spike, TACOS rise, margin drop -- is the alert; growth pushes ' +
      'are out of scope, stability is the goal.',
    threshold_overrides: {
      tacos_rise_alert_pct: 0.2,
      margin_drop_alert_pct: -0.1,
      spend_spike_pct: 0.3,
    },
    tacos_margin_behavior: 'alert_on_rise',
    impression_rank_critical: false,
    escalate_spend_spike: true,
    pacing_overrides: { warn_above: 1.05, act_above: 1.15 },
  },
  [GOAL_LIQUIDATE]: {
    label: 'Liquidate',
    description:
      'Clearing inventory fast (excess stock, sunsetting SKU). Margin erosion, and even a ' +
      'real loss on ads, is expected -- the real risk is NOT selling through fast enough.',
    threshold_overrides: { near_zero_impressions_ratio: 0.25, zero_sales_spend_min: 40.0 },
    tacos_margin_behavior: 'expected_high',
    impression_rank_critical: false,
    downgrade_zero_sales: true,
  },
  [GOAL_INACTIVE]: {
    label: 'Inactive',
    description:
      'Account not live yet (or paused entirely) -- runs are normally skipped. If data does ' +
      'show up, any ad spend at all is unexpected and worth a look; everything else is noise.',
    threshold_overrides: { spend_spike_pct: 0.2, zero_sales_spend_min: 10.0 },
    tacos_margin_behavior: 'ignore',
    impression_rank_critical: false,
  },
  [GOAL_NEUTRAL]: {
    label: 'Neutral',
    description: 'No goal profile on file yet -- plain thresholds, no goal-based severity changes.',
    threshold_overrides: {},
    tacos_margin_behavior: 'ignore',
    impression_rank_critical: false,
  },
};

/** Unknown or missing goal resolves to the neutral lens. */
export function resolveGoalLens(goal: string | null | undefined): GoalLens {
  return (goal !== null && goal !== undefined ? GOAL_LENSES[goal] : undefined) ?? (GOAL_LENSES[DEFAULT_GOAL] as GoalLens);
}

/** Per-account config: only the keys the engine knows are read. */
export interface FlagsConfig {
  thresholds?: Partial<Thresholds>;
}

/**
 * Layering, lowest to highest: toolkit defaults, goal-lens overrides, explicit
 * per-account config. Config always wins; a lens is a per-goal default, never
 * a hard rule.
 */
export function resolveThresholds(config?: FlagsConfig | null, lens?: GoalLens | null): Thresholds {
  const merged: Thresholds = { ...DEFAULT_THRESHOLDS };
  const known = Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>;
  if (lens?.threshold_overrides) {
    for (const key of known) {
      const value = lens.threshold_overrides[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  if (config?.thresholds) {
    for (const key of known) {
      const value = config.thresholds[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/** Python `_pct`: `None` renders as `n/a`, otherwise a whole-percent string. */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `${formatFixed(value * 100, 0)}%`;
}

function escalate(severity: Severity): Severity {
  const idx = SEVERITY_LADDER.indexOf(severity);
  const from = idx === -1 ? SEVERITY_LADDER.length - 1 : idx;
  return SEVERITY_LADDER[Math.max(from - 1, 0)] as Severity;
}

function downgrade(severity: Severity): Severity {
  const idx = SEVERITY_LADDER.indexOf(severity);
  const from = idx === -1 ? SEVERITY_LADDER.length - 1 : idx;
  return SEVERITY_LADDER[Math.min(from + 1, SEVERITY_LADDER.length - 1)] as Severity;
}

function flag(partial: Omit<Flag, 'suppressed' | 'suppressedReason'> & Partial<Pick<Flag, 'suppressed' | 'suppressedReason'>>): Flag {
  return {
    suppressed: false,
    suppressedReason: null,
    ...partial,
  };
}

type CampaignCheck = (series: SeriesAnalysis, thresholds: Thresholds, lens?: GoalLens | null) => Flag | null;

const checkSpendSpike: CampaignCheck = (series, thresholds, lens) => {
  const d = series.deltas['spend'];
  if (!d || d.trailing7PctChange === null) return null;
  if (d.trailing7PctChange >= thresholds.spend_spike_pct) {
    let severity: Severity = SEVERITY_WARN;
    let cause =
      'Spend spike: bid/budget change, new campaign, or a competitor pullback opening cheaper auctions. Check for an intentional change first.';
    if (lens?.escalate_spend_spike) {
      severity = escalate(severity);
      cause += ` Escalated under the '${lens.label}' goal: aggressive spend growth needs a reason, not a shrug.`;
    }
    return flag({
      severity,
      metric: 'spend',
      threshold: `>= +${pct(thresholds.spend_spike_pct)} vs trailing-7 avg`,
      message: `Spend ${pct(d.trailing7PctChange)} vs trailing-7 avg (${formatMoney(d.value as number)} vs ${formatMoney(d.trailing7Avg as number)} avg).`,
      likelyCause: cause,
      scope: series.label,
      category: series.category,
    });
  }
  return null;
};

const checkSpendCollapse: CampaignCheck = (series, thresholds) => {
  const d = series.deltas['spend'];
  if (!d || d.trailing7PctChange === null) return null;
  // Spike wins when a lens override makes the two ranges overlap, as the
  // single combined check did before the split.
  if (d.trailing7PctChange >= thresholds.spend_spike_pct) return null;
  if (d.trailing7PctChange <= thresholds.spend_collapse_pct) {
    return flag({
      severity: SEVERITY_WARN,
      metric: 'spend',
      threshold: `<= ${pct(thresholds.spend_collapse_pct)} vs trailing-7 avg`,
      message: `Spend ${pct(d.trailing7PctChange)} vs trailing-7 avg (${formatMoney(d.value as number)} vs ${formatMoney(d.trailing7Avg as number)} avg).`,
      likelyCause:
        'Spend collapse: budget exhaustion earlier in the day, a paused campaign/ad group, out-of-stock advertised SKU, or a suppressed listing.',
      scope: series.label,
      category: series.category,
    });
  }
  return null;
};

const checkBudgetCapped: CampaignCheck = (series, thresholds) => {
  const row = series.reportRow;
  if (!row || !row.budgetCapped) return null;
  let cause = 'Campaign hit its daily budget cap; it stopped serving before demand ran out.';
  if (series.category === CATEGORY_RANK) {
    cause +=
      " On a Rank/SKW campaign this means lost impression share on the exact keyword we're trying to rank -- raise the budget rather than let it cap.";
  }
  return flag({
    severity: SEVERITY_WARN,
    metric: 'spend',
    threshold: `budget-capped >= ${thresholds.budget_capped_min_days} day(s)`,
    message: row.budget
      ? `Budget-capped on the report date (spend ${formatMoney(row.spend)} of ${formatMoney(row.budget)} budget).`
      : 'Budget-capped on the report date.',
    likelyCause: cause,
    scope: series.label,
    category: series.category,
  });
};

const checkCvrDropStableClicks: CampaignCheck = (series, thresholds) => {
  const cvrD = series.deltas['cvr'];
  const clicksD = series.deltas['clicks'];
  if (!cvrD || !clicksD) return null;
  if (cvrD.trailing7PctChange === null || clicksD.trailing7PctChange === null) return null;
  if (cvrD.trailing7PctChange > thresholds.cvr_drop_pct) return null;
  if (Math.abs(clicksD.trailing7PctChange) > thresholds.clicks_stable_band_pct) return null;
  return flag({
    severity: SEVERITY_WARN,
    metric: 'cvr',
    threshold: `<= ${pct(thresholds.cvr_drop_pct)} vs trailing-7 avg with clicks within +/-${pct(thresholds.clicks_stable_band_pct)}`,
    message: `CVR ${pct(cvrD.trailing7PctChange)} vs trailing-7 avg while clicks held (${pct(clicksD.trailing7PctChange)}).`,
    likelyCause:
      "Clicks are stable so this isn't a bid/visibility issue -- check the listing (price, stock, reviews, image, buy box) rather than the campaign.",
    scope: series.label,
    category: series.category,
  });
};

const checkNearZeroImpressionsRank: CampaignCheck = (series, thresholds, lens) => {
  if (series.category !== CATEGORY_RANK) return null;
  const d = series.deltas['impressions'];
  if (!d || d.value === null) return null;
  const ratioOk = Boolean(d.trailing7Avg) && d.value <= thresholds.near_zero_impressions_ratio * (d.trailing7Avg as number);
  const absOk = d.value <= thresholds.near_zero_impressions_abs;
  if (!ratioOk && !absOk) return null;
  let severity: Severity = SEVERITY_ALERT;
  let cause =
    "Likely suppressed listing, out-bid, budget/end-date issue, or paused by mistake. This is the keyword we're trying to rank -- treat as urgent.";
  if (lens?.impression_rank_critical) {
    severity = escalate(severity);
    cause += ` Escalated to CRITICAL under the '${lens.label}' goal: losing impression share on the keyword we're trying to rank/hold is the single worst outcome.`;
  }
  return flag({
    severity,
    metric: 'impressions',
    threshold: `<= ${thresholds.near_zero_impressions_abs} impressions or <= ${pct(thresholds.near_zero_impressions_ratio)} of trailing-7 avg`,
    message: `Rank/SKW campaign impressions collapsed to ${formatFixed(d.value, 0, true)} (trailing-7 avg ${formatFixed(d.trailing7Avg as number, 0, true)}).`,
    likelyCause: cause,
    scope: series.label,
    category: series.category,
  });
};

const checkZeroSalesSpend: CampaignCheck = (series, thresholds, lens) => {
  const row = series.reportRow;
  const spendD = series.deltas['spend'];
  const ordersD = series.deltas['orders'];
  if (!row || !spendD || !ordersD) return null;
  // The trailing week, not the single report day, so one lucky click does not
  // hide a genuine negative-keyword candidate.
  const trailingSpend = spendD.trailing7Avg ?? 0.0;
  const trailingOrders = ordersD.trailing7Avg ?? 0.0;
  if (trailingSpend < thresholds.zero_sales_spend_min || trailingOrders > 0 || (row.orders || 0) > 0) return null;
  let severity: Severity = SEVERITY_ALERT;
  let cause = 'Zero orders despite real spend over the trailing week -- negative-keyword/target candidate.';
  if (series.category === CATEGORY_RANK) {
    severity = SEVERITY_WARN;
    cause +=
      ' Rank/SKW campaigns may intentionally run at break-even or a loss to drive rank (strategy.md) -- verify this is the plan, not simply wasted spend, before cutting it.';
  }
  if (lens?.downgrade_zero_sales) {
    severity = downgrade(severity);
    cause += ` Downgraded under the '${lens.label}' goal: some loss-driving spend to sell through fast is the plan.`;
  }
  return flag({
    severity,
    metric: 'orders',
    threshold: `>= $${formatFixed(thresholds.zero_sales_spend_min, 0)} trailing-7 avg spend with 0 orders`,
    message: `~${formatMoney(trailingSpend)}/day trailing-7 avg spend with 0 orders (report day spend ${formatMoney(row.spend)}).`,
    likelyCause: cause,
    scope: series.label,
    category: series.category,
  });
};

/**
 * A real ACOS swing outside Rank/SKW. Rank/SKW suppression lives in
 * `evaluate` so the suppressed-versus-active split stays in one place.
 */
const checkAcosSwing: CampaignCheck = (series, thresholds) => {
  if (series.category === CATEGORY_RANK) return null;
  const d = series.deltas['acos'];
  if (!d || d.trailing7PctChange === null) return null;
  if (Math.abs(d.trailing7PctChange) < thresholds.acos_swing_pct) return null;
  const direction = d.trailing7PctChange > 0 ? 'up' : 'down';
  return flag({
    severity: SEVERITY_INFO,
    metric: 'acos',
    threshold: `>= +/-${pct(thresholds.acos_swing_pct)} vs trailing-7 avg`,
    message: `ACOS swung ${direction} ${pct(d.trailing7PctChange)} vs trailing-7 avg (${pct(d.value)} vs ${pct(d.trailing7Avg)} avg).`,
    likelyCause:
      'Wait for a full attribution window before reacting; exclude event days from the read. Check bid/placement changes and competitor activity before touching bids.',
    scope: series.label,
    category: series.category,
  });
};

function acosSwingWouldFire(series: SeriesAnalysis, thresholds: Thresholds): boolean {
  const d = series.deltas['acos'];
  if (!d || d.trailing7PctChange === null) return false;
  return Math.abs(d.trailing7PctChange) >= thresholds.acos_swing_pct;
}

const CAMPAIGN_CHECKS: ReadonlyArray<readonly [FlagFamily, CampaignCheck]> = [
  ['spend_spike', checkSpendSpike],
  ['spend_collapse', checkSpendCollapse],
  ['budget_capped', checkBudgetCapped],
  ['cvr_drop', checkCvrDropStableClicks],
  ['near_zero_impressions', checkNearZeroImpressionsRank],
  ['zero_sales_spend', checkZeroSalesSpend],
  ['acos_swing', checkAcosSwing],
];

function checkDiscoveryShare(analysis: AnalysisResult, thresholds: Thresholds): Flag | null {
  let discoverySpend = 0.0;
  let totalSpend = 0.0;
  let anyData = false;
  for (const series of analysis.campaignSeries) {
    const d = series.deltas['spend'];
    if (!d || d.value === null) continue;
    anyData = true;
    totalSpend += d.value;
    if (series.category === CATEGORY_DISCOVERY) discoverySpend += d.value;
  }
  if (!anyData || totalSpend <= 0) return null;
  const share = discoverySpend / totalSpend;
  if (share <= thresholds.discovery_share_max) return null;
  return flag({
    severity: SEVERITY_WARN,
    metric: 'discovery_share_of_spend',
    threshold: `> ${pct(thresholds.discovery_share_max)} of total spend`,
    message: `Discovery campaigns are ${pct(share)} of today's spend (target ~${pct(thresholds.discovery_share_max)} or less).`,
    likelyCause:
      'Discovery bloat: broad/auto/phrase campaigns are absorbing budget that should be funding Rank/exact. Review Discovery bids and search-term hygiene.',
    scope: 'account',
    category: CATEGORY_DISCOVERY,
  });
}

/**
 * Account-level TACOS-rise / margin-drop read, gated entirely by the lens.
 * Returns `[active, suppressed]`, either of which may be null.
 */
function checkGoalAwareTacosMargin(
  analysis: AnalysisResult,
  thresholds: Thresholds,
  lens: GoalLens,
): [Flag | null, Flag | null] {
  const behavior = lens.tacos_margin_behavior ?? 'ignore';
  if (behavior === 'ignore') return [null, null];

  const series = analysis.accountSeries;
  const tacosD = series.deltas['tacos'];
  const marginD = series.deltas['margin'];
  const tacosRise = Boolean(
    tacosD && tacosD.trailing7PctChange !== null && tacosD.trailing7PctChange >= thresholds.tacos_rise_alert_pct,
  );
  const marginDrop = Boolean(
    marginD && marginD.trailing7PctChange !== null && marginD.trailing7PctChange <= thresholds.margin_drop_alert_pct,
  );
  if (!tacosRise && !marginDrop) return [null, null];

  const bits: string[] = [];
  if (tacosRise && tacosD) {
    bits.push(
      `TACOS ${pct(tacosD.trailing7PctChange)} vs trailing-7 avg (${pct(tacosD.value)} vs ${pct(tacosD.trailing7Avg)} avg)`,
    );
  }
  if (marginDrop && marginD) {
    bits.push(
      `margin ${pct(marginD.trailing7PctChange)} vs trailing-7 avg (${pct(marginD.value)} vs ${pct(marginD.trailing7Avg)} avg)`,
    );
  }
  const message = `${bits.join('; ')}.`;
  const threshold =
    `>= +${pct(thresholds.tacos_rise_alert_pct)} TACOS or ` +
    `<= ${pct(thresholds.margin_drop_alert_pct)} margin vs trailing-7 avg`;

  if (behavior === 'expected_high') {
    return [
      null,
      flag({
        severity: SEVERITY_INFO,
        metric: 'tacos_margin',
        threshold,
        message,
        likelyCause: `Expected under the '${lens.label}' goal: ${lens.description}`,
        scope: 'account',
        category: CATEGORY_UNKNOWN,
        suppressed: true,
        suppressedReason: `'${lens.label}' goal treats rising TACOS / falling margin as the plan, not a problem.`,
      }),
    ];
  }

  return [
    flag({
      severity: SEVERITY_ALERT,
      metric: 'tacos_margin',
      threshold,
      message,
      likelyCause: `Under the '${lens.label}' goal this is exactly the signal to act on: ${lens.description}`,
      scope: 'account',
      category: CATEGORY_UNKNOWN,
    }),
    null,
  ];
}

function compareFlags(a: Flag, b: Flag): number {
  const sa = SEVERITY_ORDER[a.severity] ?? 9;
  const sb = SEVERITY_ORDER[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
  if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
  return 0;
}

/**
 * Which rule raised a flag. The flag contract itself is unchanged (the parity
 * goldens pin it), so the family travels next to the flag in `FlagContext`.
 * `pacing` is raised by `pacingFlag` in `pacing.ts`, not by `evaluate`; it is
 * listed so a caller can place a pacing flag in the same issue taxonomy.
 */
export type FlagFamily =
  | 'spend_spike'
  | 'spend_collapse'
  | 'budget_capped'
  | 'cvr_drop'
  | 'near_zero_impressions'
  | 'zero_sales_spend'
  | 'acos_swing'
  | 'discovery_share'
  | 'tacos_margin'
  | 'pacing';

/** Inclusive calendar-day window a signal was read over. */
export interface FlagWindow {
  start: string;
  end: string;
}

/** Observed evidence for one series over the evaluation window. */
export interface SeriesEvidence {
  /** Summed impressions over the window; null when the feed does not report impressions. */
  impressions: number | null;
  /** Days in the window with a row for this series. */
  days: number;
}

/** Exact window evidence, built from the same rows the analysis was built from. */
export interface EvaluateEvidence {
  account: SeriesEvidence;
  /** Keyed by campaign id, as `analyzeAccount` keys its campaign series. */
  campaigns: Record<string, SeriesEvidence>;
}

export interface FlagEvidence extends SeriesEvidence {
  window: FlagWindow;
  /**
   * `rows` when counted from the input rows; `inferred` when `evaluate` had
   * only the analysis and assumed a complete trailing week. Inferred evidence
   * is descriptive only: the floor is applied to row evidence, never to it.
   */
  source: 'rows' | 'inferred';
}

export interface FlagContext {
  flag: Flag;
  family: FlagFamily;
  /** The campaign a flag is about; null for an account-level flag. */
  campaignId: string | null;
  evidence: FlagEvidence;
}

export interface EvidenceFloor {
  /** Null when the impressions floor does not apply to this signal. */
  minImpressions: number | null;
  minDays: number;
}

export interface FlooredFlag extends FlagContext {
  floor: EvidenceFloor;
}

export interface EvaluateResult {
  active: Flag[];
  suppressed: Flag[];
  /** One entry per `active` flag, in the same order. */
  activeContext: FlagContext[];
  /** One entry per `suppressed` flag, in the same order. */
  suppressedContext: FlagContext[];
  /**
   * Signals a rule would have raised or noted, held back because the window
   * is below the family's evidence floor. Counted, never silently dropped.
   * Always empty when `evaluate` was given no row evidence.
   */
  floored: FlooredFlag[];
}

/** The window every trailing-week check reads: the report day and the seven days before it. */
export function evaluationWindow(reportDate: string): FlagWindow {
  return { start: addDays(reportDate, -7), end: reportDate };
}

function summarize(rows: readonly DailyRow[], window: FlagWindow): SeriesEvidence {
  const days = new Set<string>();
  let impressions = 0;
  for (const row of rows) {
    if (row.date < window.start || row.date > window.end) continue;
    days.add(row.date);
    impressions += row.impressions;
  }
  return { impressions, days: days.size };
}

/**
 * Count the evidence behind each series from the rows given to
 * `analyzeAccount`. Rows outside the evaluation window are ignored.
 */
export function windowEvidence(
  reportDate: string,
  accountRows: readonly DailyRow[],
  campaignRows: readonly DailyRow[],
): EvaluateEvidence {
  const window = evaluationWindow(reportDate);
  const byCampaign = new Map<string, DailyRow[]>();
  for (const row of campaignRows) {
    const key = row.campaignId ?? '';
    const bucket = byCampaign.get(key);
    if (bucket) bucket.push(row);
    else byCampaign.set(key, [row]);
  }
  const campaigns: Record<string, SeriesEvidence> = {};
  for (const [key, rows] of byCampaign) campaigns[key] = summarize(rows, window);
  return { account: summarize(accountRows, window), campaigns };
}

function inferEvidence(series: SeriesAnalysis): SeriesEvidence {
  const d = series.deltas['impressions'];
  const trailingPresent = Object.values(series.deltas).some((delta) => delta.trailing7Avg !== null);
  const days = (series.reportRow === null ? 0 : 1) + (trailingPresent ? 7 : 0);
  if (!d) return { impressions: null, days };
  return { impressions: (d.value ?? 0) + 7 * (d.trailing7Avg ?? 0), days };
}

function evidenceFor(
  series: SeriesAnalysis,
  isAccount: boolean,
  window: FlagWindow,
  evidence: EvaluateEvidence | null | undefined,
): FlagEvidence {
  if (evidence) {
    const observed = isAccount ? evidence.account : evidence.campaigns[series.campaignId ?? ''];
    if (observed) return { ...observed, window, source: 'rows' };
    return { impressions: null, days: 0, window, source: 'rows' };
  }
  return { ...inferEvidence(series), window, source: 'inferred' };
}

/** The floor for one family; impressions apply to campaign-scoped signals only. */
export function evidenceFloor(family: FlagFamily, thresholds: Thresholds, campaignScoped: boolean): EvidenceFloor | null {
  const pair = ((): [number | null, number] | null => {
    switch (family) {
      case 'spend_spike':
        return [thresholds.floor_spend_spike_min_impressions, thresholds.floor_spend_spike_min_days];
      case 'spend_collapse':
        return [thresholds.floor_spend_collapse_min_impressions, thresholds.floor_spend_collapse_min_days];
      case 'budget_capped':
        return [thresholds.floor_budget_capped_min_impressions, thresholds.floor_budget_capped_min_days];
      case 'cvr_drop':
        return [thresholds.floor_cvr_drop_min_impressions, thresholds.floor_cvr_drop_min_days];
      case 'near_zero_impressions':
        return [thresholds.floor_near_zero_impressions_min_impressions, thresholds.floor_near_zero_impressions_min_days];
      case 'zero_sales_spend':
        return [thresholds.floor_zero_sales_spend_min_impressions, thresholds.floor_zero_sales_spend_min_days];
      case 'acos_swing':
        return [thresholds.floor_acos_swing_min_impressions, thresholds.floor_acos_swing_min_days];
      case 'discovery_share':
        return [null, thresholds.floor_discovery_share_min_days];
      case 'tacos_margin':
        return [null, thresholds.floor_tacos_margin_min_days];
      case 'pacing':
        return null;
    }
  })();
  if (pair === null) return null;
  return { minImpressions: campaignScoped ? pair[0] : null, minDays: pair[1] };
}

/** True when the evidence is below the floor. An unmeasured impression count is not zero. */
function belowFloor(evidence: FlagEvidence, floor: EvidenceFloor): boolean {
  if (evidence.days < floor.minDays) return true;
  return floor.minImpressions !== null && evidence.impressions !== null && evidence.impressions < floor.minImpressions;
}

function sortContexts<T extends FlagContext>(items: T[]): T[] {
  return [...items].sort((a, b) => compareFlags(a.flag, b.flag));
}

/**
 * Evaluate every rule over an analysis.
 *
 * `goal` is the brand's stage from its ops profile; unknown or missing resolves
 * to the neutral lens, which leaves every threshold and severity untouched.
 *
 * `evidence` (from `windowEvidence`) turns the evidence floor on. A caller
 * that passes it must surface `floored` (at least its count); a caller that
 * does not gets exactly the pre-floor output, so no signal can disappear
 * from a surface that was never taught to count it.
 */
export function evaluate(
  analysis: AnalysisResult,
  config?: FlagsConfig | null,
  goal?: string | null,
  evidence?: EvaluateEvidence | null,
): EvaluateResult {
  const lens = resolveGoalLens(goal);
  const thresholds = resolveThresholds(config, lens);
  const window = evaluationWindow(analysis.reportDate);
  const active: FlagContext[] = [];
  const suppressed: FlagContext[] = [];
  const floored: FlooredFlag[] = [];

  const admit = (target: FlagContext[], context: FlagContext, campaignScoped: boolean) => {
    const floor = evidence ? evidenceFloor(context.family, thresholds, campaignScoped) : null;
    if (floor !== null && belowFloor(context.evidence, floor)) floored.push({ ...context, floor });
    else target.push(context);
  };

  const accountEvidence = evidenceFor(analysis.accountSeries, true, window, evidence);
  const allSeries = [analysis.accountSeries, ...analysis.campaignSeries];
  for (const series of allSeries) {
    if (series.reportRow === null) continue;
    const isAccount = series === analysis.accountSeries;
    const seriesEvidence = isAccount ? accountEvidence : evidenceFor(series, false, window, evidence);
    const campaignId = isAccount ? null : series.campaignId;
    for (const [family, check] of CAMPAIGN_CHECKS) {
      const result = check(series, thresholds, lens);
      if (result !== null) admit(active, { flag: result, family, campaignId, evidence: seriesEvidence }, !isAccount);
    }
    // A Rank/SKW campaign's ACOS swing is expected under last-click
    // attribution: surfaced as suppressed, never as an active flag, even
    // though the raw threshold would trigger.
    if (series.category === CATEGORY_RANK && acosSwingWouldFire(series, thresholds)) {
      const d = series.deltas['acos'];
      if (d) {
        admit(suppressed, {
          flag: flag({
            severity: SEVERITY_INFO,
            metric: 'acos',
            threshold: `>= +/-${pct(thresholds.acos_swing_pct)} vs trailing-7 avg`,
            message: `ACOS swung ${pct(d.trailing7PctChange)} vs trailing-7 avg (${pct(d.value)} vs ${pct(d.trailing7Avg)} avg).`,
            likelyCause:
              'Expected on a Rank/SKW campaign: last-click attribution makes top-of-search ACOS unreliable as a decision signal (strategy.md). Not flagged.',
            scope: series.label,
            category: series.category,
            suppressed: true,
            suppressedReason:
              'High/volatile ACOS on a Rank/SKW campaign is a known attribution artifact, not a real anomaly, per the rank-first philosophy.',
          }),
          family: 'acos_swing',
          campaignId,
          evidence: seriesEvidence,
        }, !isAccount);
      }
    }
  }

  const discoveryFlag = checkDiscoveryShare(analysis, thresholds);
  if (discoveryFlag !== null) {
    admit(active, { flag: discoveryFlag, family: 'discovery_share', campaignId: null, evidence: accountEvidence }, false);
  }

  const [tacosMarginActive, tacosMarginSuppressed] = checkGoalAwareTacosMargin(analysis, thresholds, lens);
  if (tacosMarginActive !== null) {
    admit(active, { flag: tacosMarginActive, family: 'tacos_margin', campaignId: null, evidence: accountEvidence }, false);
  }
  if (tacosMarginSuppressed !== null) {
    admit(suppressed, { flag: tacosMarginSuppressed, family: 'tacos_margin', campaignId: null, evidence: accountEvidence }, false);
  }

  const activeContext = sortContexts(active);
  const suppressedContext = sortContexts(suppressed);
  return {
    active: activeContext.map((context) => context.flag),
    suppressed: suppressedContext.map((context) => context.flag),
    activeContext,
    suppressedContext,
    floored: sortContexts(floored),
  };
}

/* ------------------------------------------------------------ issues ----- */

/**
 * What is wrong, in words, for an operator. Listed in priority order: when
 * two issue groups carry the same top severity, the earlier one leads.
 */
export type FlagIssue =
  | 'impressions_collapsed'
  | 'spend_without_sales'
  | 'pacing_off_plan'
  | 'tacos_margin'
  | 'spend_rising'
  | 'budget_capped'
  | 'conversion_falling'
  | 'spend_falling'
  | 'discovery_heavy'
  | 'acos_swing';

export interface FlagIssueDefinition {
  id: FlagIssue;
  label: string;
  families: readonly FlagFamily[];
}

export const FLAG_ISSUES: readonly FlagIssueDefinition[] = [
  { id: 'impressions_collapsed', label: 'Near-zero impressions', families: ['near_zero_impressions'] },
  { id: 'spend_without_sales', label: 'Spend with no sales', families: ['zero_sales_spend'] },
  { id: 'pacing_off_plan', label: 'Monthly budget off pace', families: ['pacing'] },
  { id: 'tacos_margin', label: 'TACOS rising or margin falling', families: ['tacos_margin'] },
  { id: 'spend_rising', label: 'Spend rising sharply', families: ['spend_spike'] },
  { id: 'budget_capped', label: 'Capped by daily budget', families: ['budget_capped'] },
  { id: 'conversion_falling', label: 'Conversion falling while clicks hold', families: ['cvr_drop'] },
  { id: 'spend_falling', label: 'Spend falling sharply', families: ['spend_collapse'] },
  { id: 'discovery_heavy', label: 'Discovery taking too much spend', families: ['discovery_share'] },
  { id: 'acos_swing', label: 'ACOS swinging against the trailing week', families: ['acos_swing'] },
];

const ISSUE_BY_FAMILY = new Map<FlagFamily, FlagIssueDefinition>(
  FLAG_ISSUES.flatMap((issue) => issue.families.map((family) => [family, issue] as const)),
);

export function flagIssue(family: FlagFamily): FlagIssueDefinition {
  const issue = ISSUE_BY_FAMILY.get(family);
  if (!issue) throw new Error(`No issue is defined for flag family ${family}`);
  return issue;
}

export interface FlagIssueGroup<T extends FlagContext = FlagContext> {
  issue: FlagIssue;
  label: string;
  /** Position in `FLAG_ISSUES`, zero first. */
  priority: number;
  /** The most severe flag in the group. */
  severity: Severity;
  items: T[];
}

/**
 * Group flags by issue. Groups lead with the most severe flag they hold, then
 * follow the fixed issue priority; rows keep their input order inside a group.
 */
export function groupFlagsByIssue<T extends FlagContext>(items: readonly T[]): FlagIssueGroup<T>[] {
  const groups = new Map<FlagIssue, FlagIssueGroup<T>>();
  for (const item of items) {
    const issue = flagIssue(item.family);
    let group = groups.get(issue.id);
    if (!group) {
      group = {
        issue: issue.id,
        label: issue.label,
        priority: FLAG_ISSUES.indexOf(issue),
        severity: item.flag.severity,
        items: [],
      };
      groups.set(issue.id, group);
    }
    if ((SEVERITY_ORDER[item.flag.severity] ?? 9) < (SEVERITY_ORDER[group.severity] ?? 9)) group.severity = item.flag.severity;
    group.items.push(item);
  }
  return [...groups.values()].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.priority - b.priority,
  );
}
