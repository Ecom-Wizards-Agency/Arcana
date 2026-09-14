'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BidHistoryModal, type BidHistoryModalProps } from '../../ui/bid-history-modal';

const OpenTargetDrawer = createContext<((targetId: string) => void) | null>(null);

/** Keep the drawer alive when a virtualized cell is replaced or leaves the viewport. */
export function TargetDrawerProvider({ children, ...props }: Omit<BidHistoryModalProps, 'onClose' | 'targetId'> & { children: ReactNode }) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const close = useCallback(() => setTargetId(null), []);
  return <OpenTargetDrawer.Provider value={setTargetId}>
    {children}
    {targetId === null ? null : createPortal(<BidHistoryModal {...props} targetId={targetId} onClose={close} />, document.body)}
  </OpenTargetDrawer.Provider>;
}

/** An explicit drawer action independent of column order and row navigation. */
export function TargetDrawerTrigger({ label, targetId }: { label: string; targetId: string }) {
  const open = useContext(OpenTargetDrawer);
  return <button type="button" className="wa-btn wa-btn--sm" aria-label={`Open Target 360 for ${label}`} aria-haspopup="dialog" disabled={open === null} onClick={(event) => { event.stopPropagation(); open?.(targetId); }}>Target 360</button>;
}
