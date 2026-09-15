import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { loadCreativeScreen } from '../creative/load';
export function load(actor: ScreenActor, params: ScreenParams) { return loadCreativeScreen(actor, params, 'campaign'); }
