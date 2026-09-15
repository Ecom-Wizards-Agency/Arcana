import { descriptor } from './descriptor';
import { redirect } from 'next/navigation';

import type { ScreenActor } from '../../server/page-read';

import { queryString, type ScreenParams } from '../types';

export async function load(_actor: ScreenActor, input: ScreenParams): Promise<never> {
  const query = queryString(input.searchParams);
  redirect(descriptor.redirectTo + (query ? `?${query}` : ''));
}
