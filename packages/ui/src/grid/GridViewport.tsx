'use client';

/**
 * The flex column a workspace puts its toolbar and grid in so the grid fills
 * the viewport instead of a fixed box, with a fullscreen mode.
 *
 * The application frame is ordinary document flow (a sidebar and a page that
 * scrolls), so nothing above this component is a sized flex container the grid
 * could stretch into. This component supplies one: in normal mode its height
 * is the viewport less its own offset from the top of the document, measured
 * once and re-measured on resize and on any change to the document's height
 * (a banner appearing above, a filter row wrapping); in fullscreen it is fixed
 * over the frame. Inside it the grid is a plain CSS flex fill (`DataGrid`
 * with no `height`), which is the part that has to be true for every table
 * that reuses this.
 *
 * Hydration-safe: the server render carries no measured height, the first
 * client render matches it, and the measurement lands in a layout effect.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { tokens } from '../theme.js';

export interface GridViewportProps {
  fullscreen?: boolean;
  /** Called on Escape in fullscreen when nothing inside claimed the key. */
  onExitFullscreen?: (() => void) | undefined;
  /** Space kept below the grid in normal mode: a footer link, page padding. */
  bottomGap?: number;
  /** The grid never shrinks below this in normal mode, whatever the offset. */
  minHeight?: number;
  children: ReactNode;
}

const MIN_HEIGHT = 320;
const BOTTOM_GAP = 40;

export function GridViewport({
  fullscreen = false,
  onExitFullscreen,
  bottomGap = BOTTOM_GAP,
  minHeight = MIN_HEIGHT,
  children,
}: GridViewportProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const [documentTop, setDocumentTop] = useState<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (fullscreen) return;
    const element = ref.current;
    if (element === null || typeof window === 'undefined') return;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setDocumentTop(rect.top + window.scrollY);
      setViewportHeight(window.innerHeight);
    };
    measure();
    window.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [fullscreen]);

  useLayoutEffect(() => {
    if (!fullscreen || typeof document === 'undefined') return;
    // The page behind a fullscreen grid must not scroll under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!fullscreen || event.key !== 'Escape' || event.defaultPrevented) return;
    onExitFullscreen?.();
  };

  const measured =
    documentTop === null || viewportHeight === null
      ? null
      : Math.max(minHeight, viewportHeight - documentTop - bottomGap);

  const style: CSSProperties = fullscreen
    ? fullscreenStyle
    : {
        ...normalStyle,
        minHeight,
        ...(measured === null ? {} : { height: measured }),
      };

  return (
    <div
      ref={ref}
      data-testid="grid-viewport"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

const normalStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space(3),
  minWidth: 0,
};

const fullscreenStyle: CSSProperties = {
  ...normalStyle,
  background: 'var(--wa-bg, #FFFFFF)',
  boxSizing: 'border-box',
  inset: 0,
  overflow: 'hidden',
  padding: tokens.space(4),
  position: 'fixed',
  zIndex: 60,
};
