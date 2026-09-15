/** Axis metadata shared by the glyph and its legend. No strategy thresholds. */
export const SIGNAL_AXES = [
  { key: 'R', label: 'Organic rank', grain: 'daily', description: 'Inverted so #1 fills the tile; source rank_observations.' },
  { key: 'T', label: 'Top-of-search impression share', grain: 'daily', description: 'Saturation is evaluated using the active strategy; no threshold is assumed here.' },
  { key: 'I', label: 'SQP impression share', grain: 'weekly', description: 'Share of query impressions in the weekly SQP report.' },
  { key: 'P', label: 'SQP purchase share', grain: 'weekly', description: 'Share of query purchases in the weekly SQP report.' },
] as const;
export const SIGNALS_TOOLTIP = SIGNAL_AXES.map((axis) => `${axis.key}: ${axis.label} (${axis.grain})`).join('; ') + '. A dotted outline means unknown, never zero.';
