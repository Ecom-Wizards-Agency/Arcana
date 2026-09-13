import { MethodDescriptor, MethodEvaluatorInput, MethodEvaluatorOutput, type MethodId, type MethodVersion } from '@wizard-ads/shared';
import { referenceDescriptor, evaluateReferenceMethod } from './reference.js';

export type MethodEvaluator = (input: MethodEvaluatorInput) => MethodEvaluatorOutput;
export interface RegisteredMethod {
  readonly descriptor: MethodDescriptor;
  readonly evaluate: MethodEvaluator;
}

/** Registration constructs an immutable entry; assembly owns the closed catalogue. */
export function registerMethod(descriptor: MethodDescriptor, evaluator: MethodEvaluator): RegisteredMethod {
  const frozen = deepFreeze(MethodDescriptor.parse(descriptor));
  return Object.freeze({ descriptor: frozen, evaluate(input: MethodEvaluatorInput) {
    const snapshot = deepFreeze(MethodEvaluatorInput.parse(input));
    if (snapshot.methodId !== frozen.id || snapshot.methodVersion !== frozen.version) {
      throw new Error('Method selection does not match the registered version');
    }
    const output = evaluator(snapshot);
    MethodEvaluatorOutput.parse(output);
    return output;
  } });
}

export function createMethodRegistry(entries: readonly RegisteredMethod[]) {
  const catalogue = new Map<string, RegisteredMethod>();
  for (const entry of entries) {
    const key = `${entry.descriptor.id}@${entry.descriptor.version}`;
    if (catalogue.has(key)) throw new Error(`Duplicate method version: ${key}`);
    catalogue.set(key, entry);
  }
  return Object.freeze({ resolveMethod(id: MethodId, version: MethodVersion): RegisteredMethod {
    const entry = catalogue.get(`${id}@${version}`);
    if (entry === undefined) throw new Error(`Unknown method version: ${id}@${version}`);
    return entry;
  } });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const registry = createMethodRegistry([registerMethod(referenceDescriptor, evaluateReferenceMethod)]);
export const resolveMethod = registry.resolveMethod;
