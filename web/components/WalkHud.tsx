'use client';
import { useEffect, useRef, useState } from 'react';
import { send } from '@/lib/bridge';

type Room = { key: string; name: string };

/** Controls for the first-person walk-through: where you are, walk to a room, an on-screen stick for
 *  touch screens (and mice), and the way back to the map. */
export default function WalkHud({ room, note, rooms, onQr }: { room: string; note?: string; rooms: Room[]; onQr?: () => void }) {
  const [help, setHelp] = useState(true);
  const pad = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef<number | null>(null);
  const last = useRef(0);

  useEffect(() => { const t = setTimeout(() => setHelp(false), 9000); return () => clearTimeout(t); }, []);
  useEffect(() => () => send({ type: 'walk', action: 'stick', x: 0, y: 0 }), []);

  const stick = (x: number, y: number, force = false) => {
    setKnob({ x, y });
    const now = performance.now();
    if (force || now - last.current > 50) { last.current = now; send({ type: 'walk', action: 'stick', x: +x.toFixed(2), y: +y.toFixed(2) }); }
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    const R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  };

  return (
    <>
      <div className="walk-bar glass">
        <span className="walk-dot" />
        <span className="walk-where"><small>Walking in</small><b>{room || '…'}</b></span>
        <select aria-label="Walk to a room" value="" onChange={e => { if (e.target.value) send({ type: 'walk', action: 'goto', room: e.target.value }); }}>
          <option value="">Walk to a room…</option>
          {[...rooms].sort((a, b) => a.name.localeCompare(b.name)).map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
        {onQr && <button title="Guest QR code for this room" onClick={onQr}>Guest QR</button>}
        <button className="ghost" title="Controls" aria-label="Walk controls" onClick={() => setHelp(!help)}><b>?</b></button>
        <button className="pri" onClick={() => send({ type: 'walk', action: 'stop' })}>Back to map</button>
      </div>
      {note && <div className="walk-note glass">{note}</div>}
      {help && (
        <div className="walk-help glass">
          <b>Walking</b>
          <dl>
            <dt>Look</dt><dd>Drag</dd>
            <dt>Go</dt><dd>Tap the floor or a doorway</dd>
            <dt>Walk</dt><dd>Stick, W A S D or arrows</dd>
          </dl>
        </div>
      )}
      <div className="walk-stick" ref={pad} aria-label="Walk stick: up walks forward, sideways turns"
        onPointerDown={e => { active.current = e.pointerId; pad.current!.setPointerCapture(e.pointerId); const p = fromEvent(e); stick(p.x, p.y, true); }}
        onPointerMove={e => { if (active.current === e.pointerId) { const p = fromEvent(e); stick(p.x, p.y); } }}
        onPointerUp={() => { active.current = null; stick(0, 0, true); }}
        onPointerCancel={() => { active.current = null; stick(0, 0, true); }}>
        <span className="walk-knob" style={{ transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` }} />
      </div>
    </>
  );
}
