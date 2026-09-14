// @vitest-environment jsdom
import { elementScroll, Virtualizer } from '@tanstack/react-virtual';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeGridOffset, observeGridRect } from './virtualizer-observers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function virtualizer() {
  const element = document.createElement('div');
  element.scrollTo = () => {};
  const notify = vi.fn();
  const instance = new Virtualizer<HTMLDivElement, Element>({
    count: 100, getScrollElement: () => element, estimateSize: () => 30,
    initialRect: { width: 1200, height: 600 }, scrollToFn: elementScroll,
    observeElementOffset: observeGridOffset, observeElementRect: observeGridRect,
    useAnimationFrameWithResizeObserver: true, onChange: notify,
  });
  const unmount = instance._didMount();
  instance._willUpdate();
  return { element, instance, notify, unmount };
}

it('does not notify after unmount when a scroll-end debounce is still pending', () => {
  const { element, notify, unmount } = virtualizer();
  element.dispatchEvent(new Event('scroll'));
  expect(notify).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  notify.mockClear();
  vi.runAllTimers();
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not notify from a ResizeObserver frame queued before unmount', () => {
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const { notify, unmount } = virtualizer();
  expect(observers).toHaveLength(1);
  observers[0]!([{ borderBoxSize: [{ inlineSize: 1200, blockSize: 600 }] }] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  notify.mockClear();
  vi.runAllTimers();
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a replacement subscription active while ignoring the old debounce', () => {
  const { element, instance, notify, unmount } = virtualizer();
  element.dispatchEvent(new Event('scroll'));
  unmount();
  const unmountAgain = instance._didMount();
  instance._willUpdate();
  notify.mockClear();
  vi.runAllTimers();
  expect(notify).not.toHaveBeenCalled();
  element.dispatchEvent(new Event('scroll'));
  vi.runAllTimers();
  expect(notify).toHaveBeenCalledTimes(1);
  unmountAgain();
});
