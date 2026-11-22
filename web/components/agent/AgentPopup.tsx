'use client';
// The AI agent as a floating popup over the 3D map (staff and guests): a launcher bottom-right of the map, a card
// above it that can expand to a tall side panel, and a bottom sheet on a phone. The conversation keeps running while
// the popup is closed: the launcher then shows how far it got, and a badge when an answer is waiting.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Activity = { busy: boolean; done: number; total: number };
export type PopupControls = { open: boolean; expanded: boolean; close: () => void; toggleExpand: () => void; onActivity: (a: Activity) => void };

/** right / top: how much of the window the page's own side panel and header take, so the popup floats over the
 *  map beside them (on a narrow screen the page stacks and the popup uses the whole window). */
export default function AgentPopup({ label = 'Ask AI', children, shortcut = true, right = 0, top = 0 }: { label?: string; shortcut?: boolean; right?: number; top?: number; children: (c: PopupControls) => ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [act, setAct] = useState<Activity>({ busy: false, done: 0, total: 0 });
  const [unread, setUnread] = useState(0);
  const openRef = useRef(open); openRef.current = open;
  const wasBusy = useRef(false);
  const card = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  const onActivity = useCallback((a: Activity) => {
    setAct(prev => (prev.busy === a.busy && prev.done === a.done && prev.total === a.total ? prev : a));
    // an answer that finished while the popup was closed is waiting
    if (wasBusy.current && !a.busy && !openRef.current) setUnread(u => u + 1);
    wasBusy.current = a.busy;
  }, []);

  const show = useCallback((v: boolean) => {
    setOpen(v);
    if (v) {
      setUnread(0);
      // straight into the message box
      setTimeout(() => card.current?.querySelector<HTMLTextAreaElement>('.ag-composer textarea')?.focus(), 60);
    } else setTimeout(() => launcher.current?.focus(), 0);
  }, []);
  const close = useCallback(() => show(false), [show]);
  const toggleExpand = useCallback(() => setExpanded(e => !e), []);

  // Ctrl/Cmd+K opens and closes it from anywhere; Esc inside it closes it
  useEffect(() => {
    if (!shortcut) return;
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); show(!openRef.current); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [shortcut, show]);

  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  if (!mounted) return null;
  // in the page body, so no container of the map clips it or holds a phone's sheet inside the map
  return createPortal(
    <div className={`agp ${open ? 'open' : ''} ${expanded ? 'expanded' : ''}`} style={{ '--agp-right': `${right}px`, '--agp-top': `${top}px` } as CSSProperties}>
      <section ref={card} className="agp-card" role="dialog" aria-label="AI agent" aria-hidden={!open} inert={!open}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="agp-handle" aria-hidden />
        {children({ open, expanded, close, toggleExpand, onActivity })}
      </section>
      {open ? (
        <button ref={launcher} type="button" className="agp-fab round" aria-label="Close the AI agent" onClick={() => show(false)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
        </button>
      ) : act.busy ? (
        <button ref={launcher} type="button" className="agp-fab working" onClick={() => show(true)} aria-label="AI agent is working. Open it">
          <span className="agp-spin" aria-hidden />{act.total > 1 ? `Working · ${act.done} of ${act.total} done` : 'Working…'}
        </button>
      ) : (
        <button ref={launcher} type="button" className="agp-fab" onClick={() => show(true)} aria-label={unread ? `${label}: ${unread} new answer${unread > 1 ? 's' : ''}` : label}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></svg>
          <span className="agp-label">{label}</span>
          {shortcut && <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>}
          {unread > 0 && <span className="agp-badge">{unread}</span>}
        </button>
      )}
    </div>,
    document.body,
  );
}

/** The popup's header: a mark, the assistant's name and state, and its actions. */
export function PopupHeader({ title, subtitle, onHistory, historyOn, onNew, canNew, ctl }: {
  title: string; subtitle: ReactNode; onHistory?: () => void; historyOn?: boolean; onNew?: () => void; canNew?: boolean; ctl?: PopupControls;
}) {
  return (
    <header className="agp-head">
      <span className="agp-mark" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></svg>
      </span>
      <div className="agp-title"><b>{title}</b><span>{subtitle}</span></div>
      {onHistory && <IconBtn label={historyOn ? 'Back to the conversation' : 'Conversation history'} on={historyOn} onClick={onHistory}>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></IconBtn>}
      {onNew && <IconBtn label="New conversation" onClick={onNew} disabled={canNew === false}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></IconBtn>}
      {ctl && <IconBtn label={ctl.expanded ? 'Back to the popup' : 'Expand to a side panel'} className="agp-expand" onClick={ctl.toggleExpand}>
        {ctl.expanded ? <><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></> : <><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></>}</IconBtn>}
      {ctl && <IconBtn label="Close" onClick={ctl.close}><path d="M18 6L6 18" /><path d="M6 6l12 12" /></IconBtn>}
    </header>
  );
}

function IconBtn({ label, onClick, children, on, disabled, className = '' }: { label: string; onClick: () => void; children: ReactNode; on?: boolean; disabled?: boolean; className?: string }) {
  return (
    <button type="button" className={`agp-icon ${on ? 'on' : ''} ${className}`} aria-label={label} title={label} aria-pressed={on} onClick={onClick} disabled={disabled}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>{children}</svg>
    </button>
  );
}
