import { redirect } from 'next/navigation';
import { queryString, type ScreenParams } from '../../types';
export async function load(input: ScreenParams): Promise<never> {
  const query = queryString(input.searchParams);
  redirect(`/prompts${query ? `?${query}` : ''}`);
}
