import assert from 'node:assert/strict';

export function aggregate(service: readonly number[], authenticated: readonly number[]) {
  const median = (values: readonly number[]) => {
    assert(values.length > 0 && values.every((v) => Number.isFinite(v) && v >= 0));
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  const serviceMs = median(service);
  const authenticatedMs = median(authenticated);
  return { serviceMs, authenticatedMs, ratio: serviceMs === 0 ? null : authenticatedMs / serviceMs };
}
