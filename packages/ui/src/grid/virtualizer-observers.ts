import { observeElementOffset, observeElementRect } from '@tanstack/react-virtual';

// Unsubscribing TanStack's observers removes listeners but does not cancel an
// already scheduled scroll-end debounce or ResizeObserver animation frame.
// Scope callbacks to the subscription so they cannot notify React after its
// virtualizer unmounts. Each new subscription, including Strict Mode remounts,
// gets its own lifetime; a stale callback cannot target the replacement.
export const observeGridOffset: typeof observeElementOffset = (instance, callback) => {
  let subscribed = true;
  const unsubscribe = observeElementOffset(instance, (offset, scrolling) => {
    if (subscribed) callback(offset, scrolling);
  });
  return () => {
    subscribed = false;
    unsubscribe?.();
  };
};

export const observeGridRect: typeof observeElementRect = (instance, callback) => {
  let subscribed = true;
  const unsubscribe = observeElementRect(instance, (rect) => {
    if (subscribed) callback(rect);
  });
  return () => {
    subscribed = false;
    unsubscribe?.();
  };
};
