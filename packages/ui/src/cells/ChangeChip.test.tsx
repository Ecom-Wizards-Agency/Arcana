// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChangeChip } from './ChangeChip.js';
afterEach(cleanup);
it('keeps provenance and state text readable in every semantic tone',()=>{
  const {container}=render(<>{(['indigo','warn','good','bad','neutral'] as const).map(tone=><ChangeChip key={tone} tone={tone}>{tone}</ChangeChip>)}</>);
  expect(container.querySelectorAll('span')).toHaveLength(5);
  expect([...container.querySelectorAll('span')].every(chip=>chip.style.color.startsWith('var('))).toBe(true);
  expect(container.querySelector('span:last-child')?.getAttribute('style')).toContain('dashed');
});
