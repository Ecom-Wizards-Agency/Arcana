// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ScreenTopbar } from '../../ui/topbar-controls';
import { descriptor } from './descriptor';
vi.mock('next/navigation', () => ({ usePathname: () => '/targets/synthetic-target', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
it('uses the descriptor title for a dynamic Target 360 path', () => {
  render(<ScreenTopbar today="2026-09-15" screens={[{ path: descriptor.path, title: descriptor.title, matchDynamic: true }]} />);
  expect(screen.getByTestId('shell-title').textContent).toBe('Target 360');
});
