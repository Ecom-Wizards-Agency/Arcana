/** Opt-in, identifier-free breakdown within the counted Targets request. */
export function targetReadTimer(): (stage: 'facts' | 'bids' | 'ranks' | 'sqp' | 'derive') => void {
  if (process.env['WIZARD_ADS_GRID_PROFILE'] !== '1') return () => {};
  let start = performance.now();
  return (stage) => {
    const end = performance.now();
    console.info(JSON.stringify({ event: 'arcana.grid_target_read', stage, durationMs: Math.round((end - start) * 100) / 100 }));
    start = end;
  };
}
