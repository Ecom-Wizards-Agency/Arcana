import { notFound, redirect } from 'next/navigation';
import { queryString, type ScreenParams } from './types';

/** Presets have executable descriptors but share the physical Grid page. */
export async function loadPreset(path: string, input: ScreenParams): Promise<never> {
  const [pathname, preset] = path.split('?');
  const query = new URLSearchParams(queryString(input.searchParams));
  for (const [key, value] of new URLSearchParams(preset)) query.set(key, value);
  redirect(`${pathname}?${query.toString()}`);
}

export async function loadPlanned(): Promise<never> {
  notFound();
}
