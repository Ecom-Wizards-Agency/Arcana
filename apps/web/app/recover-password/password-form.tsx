'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import { Banner, Button, Field, Input, LinkButton } from '../../src/ui/primitives';
import { completePasswordRecovery } from './actions';
import type { CompleteRecoveryResult } from './actions';
import { authContinuePath } from '../../src/auth/continuation';

const IDLE: CompleteRecoveryResult = { status: 'idle' };

export function RecoveryPasswordForm({ next, setup = false }: { next: string; setup?: boolean }): ReactNode {
  const [result, action, pending] = useActionState(completePasswordRecovery, IDLE);
  return (
    <>
      <form action={action} style={{ display: 'grid', gap: '0.75rem' }}>
        <input type="hidden" name="next" value={next} />
        <Field label="New password" htmlFor="recovery-password" hint="Use at least 10 characters.">
          <Input id="recovery-password" name="password" type="password" autoComplete="new-password" minLength={10} required disabled={pending} />
        </Field>
        <Field label="Confirm password" htmlFor="recovery-confirmation">
          <Input id="recovery-confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={10} required disabled={pending} />
        </Field>
        <Button type="submit" disabled={pending}>{pending ? 'Saving...' : setup ? 'Set password' : 'Replace password'}</Button>
      </form>
      {result.status === 'idle' ? null : (
        <Banner tone={result.status === 'ok' ? 'good' : result.status === 'challenge' ? 'warn' : 'bad'} role={result.status === 'ok' ? 'status' : 'alert'}>
          {result.message}
        </Banner>
      )}
      {result.status === 'challenge' ? <LinkButton href={result.href}>Verify authenticator</LinkButton> : null}
      {result.status === 'ok' ? <LinkButton href={authContinuePath(next)}>Continue</LinkButton> : null}
      {result.status === 'error' ? <LinkButton href={`/login?${new URLSearchParams({ next }).toString()}`}>Try signing in</LinkButton> : null}
    </>
  );
}
