import { redirect } from 'next/navigation';
import { decideAssurance, requiredAssurance } from '../../../src/auth/assurance';
import { authFeatureConfig } from '../../../src/auth/config';
import { assuranceDestination } from '../../../src/auth/continuation';
import { safeNextPath } from '../../../src/auth/next-path';
import { currentSessionSecurity, currentUser } from '../../../src/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A page keeps the final redirect in App Router's navigation protocol. A Route
 * Handler redirect can instead be followed by the server-action RSC fetch,
 * streaming the destination while leaving the browser at this intermediate URL.
 */
export default async function AuthContinuePage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}): Promise<never> {
  const next = safeNextPath((await searchParams).next, '/dashboard');
  const config = authFeatureConfig();
  if (config.totpPolicy === 'off' || config.totpPolicy === 'enrollment-only') {
    const user = await currentUser();
    redirect(user === null ? `/login?${new URLSearchParams({ next }).toString()}` : next);
  }
  const decision = decideAssurance({
    session: await currentSessionSecurity(),
    requirement: requiredAssurance({ config, surface: 'operator' }),
    returnTo: next,
  });
  redirect(decision.kind === 'allow' ? next : assuranceDestination(decision));
}
