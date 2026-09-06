/**
 * The Supabase Auth client, server side.
 *
 * Auth only. OpenSpell reads its data over a direct Postgres connection
 * (`@wizard-ads/db`), the same way `/crosscheck` already does, so this client
 * handles password sign-in, invitations/recovery, optional providers and account
 * security, and verifies the session identity. Nothing here queries a table.
 *
 * `@supabase/ssr` wants cookie get/set closures because the auth cookie is
 * rotated on refresh. In a React Server Component the cookie store is
 * read-only, so `setAll` is allowed to fail there: the route handlers and
 * server actions that *can* write are where a refreshed token gets persisted.
 */
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { required } from '../env';

export async function supabaseServerClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            // Read-only cookie store (a Server Component). Refresh happens on
            // the next route handler; swallowing here is the documented shape.
          }
        },
      },
    },
  );
}

/** Is Supabase Auth configured at all? Lets a page say so instead of throwing. */
export function supabaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['NEXT_PUBLIC_SUPABASE_URL'] && env['NEXT_PUBLIC_SUPABASE_ANON_KEY']);
}
