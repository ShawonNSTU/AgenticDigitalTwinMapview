'use client';
import { useEffect, useRef, useState } from 'react';

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** Full screen for the map and what floats over it (the section the button sits in), and back. The whole page goes
 *  full screen (Fullscreen API; the webkit form on Safari/iPad) with that section stretched over it, so things the
 *  page keeps outside the map (the AI agent popup) stay on screen too. Where a browser has no Fullscreen API
 *  (iPhone) the section is just stretched over the window. Esc, or the button again, returns to the normal view. */
export default function FullscreenButton({ className = 'fs-float', label = false }: { className?: string; label?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [on, setOn] = useState(false);
  const target = () => (btn.current?.closest('[data-fullscreen]') ?? btn.current?.closest('section')) as HTMLElement | null;
  useEffect(() => {
    const doc = document as FsDoc;
    const sync = () => {
      const fs = !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
      // the page left full screen (Esc, the browser's own control): the section goes back into the page
      if (!fs) for (const el of document.querySelectorAll('.pseudo-full.via-fs')) { el.classList.remove('pseudo-full', 'via-fs'); document.body.classList.remove('has-pseudo-full'); }
      setOn(fs || !!document.querySelector('.pseudo-full'));
      window.dispatchEvent(new Event('resize'));
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.querySelector('.pseudo-full:not(.via-fs)')) { document.querySelector('.pseudo-full')!.classList.remove('pseudo-full'); document.body.classList.remove('has-pseudo-full'); sync(); } };
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('webkitfullscreenchange', sync); window.removeEventListener('keydown', esc); };
  }, []);
  const toggle = async () => {
    const doc = document as FsDoc, el = target(), page = document.documentElement as FsEl;
    if (!el) return;
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) { await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()); return; }
    if (el.classList.contains('pseudo-full')) { el.classList.remove('pseudo-full', 'via-fs'); document.body.classList.remove('has-pseudo-full'); setOn(false); return; }
    el.classList.add('pseudo-full'); document.body.classList.add('has-pseudo-full'); setOn(true);
    try {
      if (page.requestFullscreen) await page.requestFullscreen({ navigationUI: 'hide' });
      else if (page.webkitRequestFullscreen) await page.webkitRequestFullscreen();
      else return;   // no Fullscreen API: stretched over the window is it
      el.classList.add('via-fs');
    } catch { /* refused: stays stretched over the window */ }
  };
  return (
    <button ref={btn} className={`${className} ${on ? 'on' : ''}`} title={on ? 'Back to the normal view (Esc)' : 'Full screen'} aria-label={on ? 'Exit full screen' : 'Full screen'} onClick={toggle}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {on ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
      {label && <span>{on ? 'Exit full screen' : 'Full screen'}</span>}
    </button>
  );
}
