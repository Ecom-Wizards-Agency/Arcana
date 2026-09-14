// @vitest-environment jsdom
import { render } from '@testing-library/react/pure';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

const unmounted: string[] = [];
let frameFlushed = false;
let timerFlushed = false;
function Mounted({ name }: { name: string }) {
  useEffect(() => () => { unmounted.push(name); }, [name]);
  return <div>{name}</div>;
}

describe.sequential('shared render cleanup across tests', () => {
  it('mounts both native and testing-library roots and queues browser work', () => {
    const container = document.createElement('div');
    document.body.append(container);
    act(() => createRoot(container).render(<Mounted name="native" />));
    render(<Mounted name="testing-library" />);
    window.requestAnimationFrame(() => { frameFlushed = true; });
    window.setTimeout(() => { timerFlushed = true; }, 0);
    expect(unmounted).toEqual([]);
    expect(document.body.textContent).toContain('native');
    expect(document.body.textContent).toContain('testing-library');
    // Leave these mounted to exercise the shared afterEach, not local cleanup.
  });

  it('starts with both roots unmounted and queued browser work drained', () => {
    expect(unmounted.sort()).toEqual(['native', 'testing-library']);
    expect(document.body.childElementCount).toBe(0);
    expect(frameFlushed).toBe(true);
    expect(timerFlushed).toBe(true);
  });
});
