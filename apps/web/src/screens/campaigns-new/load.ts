import { redirect } from 'next/navigation';
import { queryString, type ScreenParams } from '../types';
import type { ScreenActor } from '../../server/page-read';
export async function load(_actor: ScreenActor, input: ScreenParams): Promise<never> {
  const query = queryString(input.searchParams);
  redirect('/campaigns' + (query ? `?${query}` : ''));
}
