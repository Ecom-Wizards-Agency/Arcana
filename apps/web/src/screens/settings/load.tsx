import { redirect } from 'next/navigation';

import type { ScreenActor } from '../../server/page-read';

import { type ScreenParams } from '../types';

export async function load(_actor: ScreenActor, _input: ScreenParams): Promise<never> {
  const query = '';
  redirect('/settings/account' + (query ? `?${query}` : ''));
}
