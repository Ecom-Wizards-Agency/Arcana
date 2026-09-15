import type { ReactElement } from 'react';
import type { ScreenActor } from '../server/page-read';

export type ScreenState = 'loading' | 'empty' | 'error' | 'not-measured' | 'gated' | 'stale' | 'refused';
export type ScreenSearchParams = Record<string, string | string[] | undefined>;
export interface ScreenParams {
  searchParams: ScreenSearchParams;
  params: Record<string, string>;
}

export type ScreenGuard =
  | { readonly kind: 'requested'; readonly canonicalProfile?: true; readonly heading?: string; }
  | {
    readonly kind: 'redirect';
    readonly pathname: string;
    readonly hash: string;
    readonly canonicalProfile: true;
    readonly artifact: string;
    readonly heading: string;
  };

export type ScreenGroupId = 'home' | 'performance' | 'research' | 'act' | 'creators' | 'timeline' | 'utility';
export interface ScreenNavigation {
  readonly group: ScreenGroupId;
  readonly label: string;
  readonly icon: string;
  readonly order: number;
  readonly badgeSource?: 'change-queue' | 'timeline';
  readonly tag?: string;
}

export interface ScreenDescriptor<Data = unknown> {
  readonly id: string;
  readonly path: string;
  /** Explicit shell title for routes without a navigation entry. */
  readonly title?: string;
  readonly route: 'page' | 'redirect' | 'preset' | 'planned';
  /** Query-preserving aliases can resolve before the application layout. */
  readonly redirectTo?: string;
  readonly nav: ScreenNavigation | null;
  readonly guard: ScreenGuard | null;
  readonly prefetch: 'cheap' | 'expensive';
  readonly rollout: { readonly enabled: boolean; readonly envFlag?: string; };
  readonly states: readonly ScreenState[];
  readonly entry: 'gate-message' | 'request-message' | 'account-security' | 'redirect' | 'feedback-bridge';
  readonly preferredOrg?: 'query';
  readonly specs: readonly { readonly file: string; readonly suite: string; }[];
  readonly load: (actor: ScreenActor, params: ScreenParams) => Promise<Data>;
  readonly client: () => Promise<(props: { data: Data; }) => ReactElement | null>;
}

export type ScreenMetadata = Pick<ScreenDescriptor, 'id' | 'path' | 'title' | 'route' | 'redirectTo' | 'nav' | 'guard' | 'prefetch' | 'rollout' | 'states' | 'entry' | 'preferredOrg' | 'specs'>;

/** Missing flags use the default. An explicit flag is enabled only by 1 or true. */
export function screenEnabled(screen: Pick<ScreenMetadata, 'rollout'>, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = screen.rollout.envFlag === undefined ? undefined : env[screen.rollout.envFlag];
  return value === undefined ? screen.rollout.enabled : value === '1' || value === 'true';
}

export function queryString(params: ScreenSearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  return query.toString();
}
