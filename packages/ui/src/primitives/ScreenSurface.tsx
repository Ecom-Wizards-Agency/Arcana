import type { ReactNode } from 'react';
import { screenSurfaceStyles } from './ScreenSurface.styles.js';

/** Shared presentation for utility screens awaiting dedicated design frames. */
export function ScreenSurface({ title, children }: { title: string; children: ReactNode }) {
  return <div className="wa-support-screen">
    <style>{screenSurfaceStyles}</style>
    <div className="wa-support-breadcrumb" aria-label="Breadcrumb">Arcana / <span>{title}</span></div>
    {children}
  </div>;
}
