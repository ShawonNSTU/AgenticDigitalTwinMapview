'use client';
// The right-hand panel (staff: Devices / Live ops; guest: Your stay / Room) can be folded away to give the map the
// whole width, like the device palette on the left; a tab on the map's right edge brings it back. Remembered per page
// in this browser.
import { useCallback, useEffect, useState } from 'react';

export function useSideOpen(key: string) {
  const [open, setOpen] = useState(true);
  useEffect(() => { try { if (localStorage.getItem(`side-${key}`) === 'closed') setOpen(false); } catch { /* no storage */ } }, [key]);
  const set = useCallback((v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(`side-${key}`, v ? 'open' : 'closed'); } catch { /* no storage */ }
    // the map renderer sizes itself to its box: tell it once the grid has changed
    setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  }, [key]);
  return [open, set] as const;
}

/** The fold button at the end of the panel's tab row. */
export function SideFold({ onFold }: { onFold: () => void }) {
  return (
    <button type="button" className="side-fold" onClick={onFold} aria-label="Hide this panel" title="Hide this panel">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}

/** The tab on the map's right edge that opens the panel again. */
export function SideTab({ label, count, onOpen }: { label: string; count?: number; onOpen: () => void }) {
  return (
    <button type="button" className="side-tab glass" onClick={onOpen} aria-label={`Show ${label}`} title={`Show ${label}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
      <b>{label}</b>{count != null && <i>{count}</i>}
    </button>
  );
}
