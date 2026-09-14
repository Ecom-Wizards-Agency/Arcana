import type { ScreenDescriptor } from '../types';

/** Bind the requested address before the shared reader canonicalizes its profile query. */
export function optimizerRouteDescriptor<Data>(
  template: ScreenDescriptor<Data>,
  params: Readonly<Record<string, string>>,
): ScreenDescriptor<Data> {
  const path = template.path.replace(/\[([^\]]+)\]/g, (_segment, parameter: string) => {
    const value = Object.hasOwn(params, parameter) ? params[parameter] : undefined;
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing optimizer route parameter: ${parameter}`);
    return encodeURIComponent(value);
  });
  return { ...template, path };
}
