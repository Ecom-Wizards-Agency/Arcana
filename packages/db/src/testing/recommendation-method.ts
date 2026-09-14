/** A public WP-252 method identity with a synthetic calculation, never tenant policy. */
export function syntheticRecommendationMethodInputs(result = 0.7) {
  const step = { index: 0, label: 'Synthetic rounding', formula: 'round(input)',
    inputs: [{ name: 'input', value: result, unit: 'currency' }], intermediateValue: result,
    boundApplied: null, result };
  return { methodId: 'sp.reference-efficiency' as const, methodVersion: 'reference.1' as const,
    settingSources: { fixture: { value: 'synthetic', source: 'run' as const, sourceLabel: 'Synthetic fixture' } },
    trace: { steps: [step], finalResult: result, roundingStep: step } };
}
