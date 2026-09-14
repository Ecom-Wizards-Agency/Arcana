'use client';
import { useSearchParams } from 'next/navigation';
import type { ComponentProps } from 'react';
import { OperatorContext } from '../../src/ui/operator-context';

/** Date changes carry the latest replaced URL, including edits since page load. */
export function GridOperatorContext(props: ComponentProps<typeof OperatorContext>) {
  const query = useSearchParams();
  return <OperatorContext {...props} preserved={{ ...props.preserved, view: query.get('view') ?? props.preserved['view'] }} />;
}
