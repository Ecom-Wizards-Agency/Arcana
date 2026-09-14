/** Opt-in browser User Timing for the counted Grid request and mount. */
export function gridWork<T>(name: string, work: () => T): T {
  if (!(globalThis as { __gridProfile?: boolean }).__gridProfile) return work();
  const start = performance.now();
  try { return work(); } finally { performance.measure(`grid.${name}`, { start }); }
}
