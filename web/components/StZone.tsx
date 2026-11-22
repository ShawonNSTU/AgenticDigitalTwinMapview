'use client';
// The 3D control for the SmartThings Experience Zone's SmartThings app devices: a SmartThings app tile, pinned
// beside the device in the 3D room, made livelier: the tile itself is the brightness or shade slider and glows
// in the light's colour, scene and colour chips change the room at once, switches flip with a tap, and the
// roller shade is drawn rolling. Every drag shows its result in the room straight away (preview) and is sent
// when the guest lets go. The guest side panel shows states only (stStatus). Other devices keep their own 3D
// controls (HoloControl).
import { useEffect, useRef, useState } from 'react';
import { send } from '@/lib/bridge';
import type { Cmd } from '@/components/DeviceControls';

export type StProfile = { kind: 'color' | 'switch' | 'shade'; group: string; where: string };
export type StDev = { id: string; type: string; name: string; online: boolean; readings: Record<string, unknown>; overrides: Record<string, unknown>; commands: Cmd[]; st?: StProfile };
type RunFn = (command: string, args?: Record<string, unknown>) => unknown;

const SCENES = [
  { key: 'night', label: 'Night', lv: 12, k: 2700, icon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' },
  { key: 'relax', label: 'Relax', lv: 40, k: 2700, icon: 'M3 18h18M6 18a6 6 0 0 1 12 0M12 6V4M5.6 9.6 4.2 8.2M18.4 9.6l1.4-1.4' },
  { key: 'read', label: 'Read', lv: 80, k: 4000, icon: 'M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z' },
  { key: 'day', label: 'Day', lv: 100, k: 6500, icon: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
];
const COLORS: Record<string, string> = { pink: '#ff6fae', purple: '#8b5cf6', blue: '#3b82f6', cyan: '#22d3ee', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };
const kelvin = (k: number) => { const f = Math.max(0, Math.min(1, (k - 2700) / 3800)); const m = (a: number, b: number) => Math.round(a + (b - a) * f); return `rgb(${m(255, 214)},${m(190, 230)},${m(120, 255)})`; };
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const preview = (id: string, readings: Record<string, unknown>, text?: string) => send({ type: 'preview', id, readings, text });

/** Pointer drag along an element: f(0..1) while moving, done() on release. */
function useSlide(el: React.RefObject<HTMLElement | null>, axis: 'x' | 'y', move: (f: number) => void, done: () => void) {
  const live = useRef(false);
  const at = (e: PointerEvent | React.PointerEvent) => {
    const b = el.current!.getBoundingClientRect();
    return axis === 'x' ? Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) : Math.max(0, Math.min(1, (e.clientY - b.top) / b.height));
  };
  useEffect(() => {
    const mv = (e: PointerEvent) => { if (live.current) move(at(e)); };
    const up = () => { if (live.current) { live.current = false; done(); } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  });
  return (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); live.current = true; move(at(e)); };
}

function Icon({ kind, name, on, color }: { kind: StProfile['kind']; name: string; on: boolean; color: string }) {
  const n = name.toLowerCase();
  const stroke = on ? color : '#8a8f98';
  const p = kind === 'shade' ? 'M4 4h16M5 4v13M19 4v13M5 17h14M12 17v3'
    : n.includes('switch') ? 'M8 3h8a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM12 7v4'
    : n.includes('window') ? 'M4 4h16v16H4zM12 4v16M4 12h16'
    : n.includes('desk') ? 'M6 21h8M10 21v-7l5-5M15 9l3-3M13 4l5 5-3 1z'
    : n.includes('tv lamp') ? 'M3 5h18v3H3zM6 8v2M12 8v2M18 8v2'
    : n.includes('side lamp') ? 'M8 3h8l2 6H6zM12 9v11M8 21h8'
    : 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z';
  return (
    <span className={`st-ico ${on ? 'on' : ''}`} style={{ ['--glow' as string]: color }}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={p} /></svg>
    </span>
  );
}

export function StTile({ dev, run, big = false, onOpen }: { dev: StDev; run: RunFn; big?: boolean; onOpen?: () => void }) {
  const kind = dev.st!.kind;
  const has = (c: string) => dev.commands.some(x => x.name === c);
  const r = { ...dev.readings, ...(dev.overrides ?? {}) } as Record<string, unknown>;
  const [lvDraft, setLv] = useState<number | null>(null);
  const [posDraft, setPos] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);

  const lv = lvDraft ?? Math.round(num(r.lv, 0));
  const isLight = dev.type === 'light';
  const on = kind === 'shade' ? true : isLight ? lv > 0 : r.on === true || r.on === 'true';
  const hex = typeof r.col === 'string' && r.col.startsWith('#') ? r.col : '';
  const color = hex || kelvin(num(r.ct, 3000));
  const pos = posDraft ?? Math.round(num(r.pos, 100)); // 100 = rolled up
  const status = !dev.online ? 'Offline' : kind === 'shade' ? (pos >= 98 ? 'Open' : pos <= 2 ? 'Closed' : `${pos}% open`) : on ? (kind === 'color' ? 'Connected' : 'On') : 'Off';

  const slideLv = useSlide(bar, 'x', f => { const v = Math.round(f * 100); setLv(v); preview(dev.id, { lv: v }, `${v} %`); },
    () => setLv(v => { if (v != null) run('setLevel', { percent: v }); return null; }));
  const slidePos = useSlide(shade, big ? 'y' : 'x', f => { const p = Math.round(100 - f * 100); setPos(p); preview(dev.id, { pos: p }, p >= 98 ? 'Open' : p <= 2 ? 'Closed' : `${p}% open`); },
    () => setPos(p => { if (p != null) run('setPosition', { percent: p }); return null; }));
  const hue = (f: number) => { const names = Object.keys(COLORS); return names[Math.min(names.length - 1, Math.floor(f * names.length))]; };
  const slideHue = useSlide(ring, 'x', f => preview(dev.id, { col: COLORS[hue(f)], lv: Math.max(lv, 40) }, hue(f)), () => {});

  const toggle = () => {
    if (!dev.online) return;
    if (isLight) { preview(dev.id, { lv: on ? 0 : Math.max(num(r.lastLv, 80), 30) }, on ? 'Off' : 'On'); run('power', { on: on ? 'false' : 'true' }); }
    else if (has('power')) { preview(dev.id, { on: !on }, on ? 'Off' : 'On'); run('power', { on: on ? 'false' : 'true' }); }
  };
  const scene = (s: typeof SCENES[number]) => {
    preview(dev.id, { lv: s.lv, ct: s.k, col: '' }, s.label);
    run('setLevel', { percent: s.lv });
    if (has('setColorTemperature')) setTimeout(() => run('setColorTemperature', { kelvin: s.k }), 200);
  };
  const paint = (c: string) => {
    preview(dev.id, { col: COLORS[c], lv: Math.max(lv, 40) }, c);
    if (lv < 40) run('setLevel', { percent: 60 });
    setTimeout(() => run('setColor', { color: c }), lv < 40 ? 200 : 0);
  };
  const activeScene = !hex && SCENES.find(s => Math.abs(s.lv - lv) <= 2 && Math.abs(s.k - num(r.ct, 0)) < 300)?.key;

  return (
    <div className={`st-tile st-k-${kind} ${on && dev.online ? 'is-on' : ''} ${big ? 'st-big' : ''} ${dev.online ? '' : 'offline'}`} style={{ ['--lc' as string]: color, ['--lv' as string]: `${kind === 'color' ? lv : on ? 100 : 0}%` }}>
      <div className="st-head" onClick={onOpen}>
        <span className="st-name"><b>{dev.name}</b><small className={dev.online ? '' : 'bad'}>{status}</small></span>
        <button className="st-iconbtn" aria-label={`${dev.name}: turn ${on ? 'off' : 'on'}`} aria-pressed={on} disabled={!dev.online || kind === 'shade'} onClick={e => { e.stopPropagation(); toggle(); }}>
          <Icon kind={kind} name={dev.name} on={on && dev.online} color={kind === 'color' ? color : '#3e91ff'} />
        </button>
      </div>
      {big && <div className="st-where">{dev.st!.where}</div>}

      {kind === 'color' && dev.online && <>
        <div className="st-bar" ref={bar} role="slider" aria-label={`${dev.name} brightness`} aria-valuenow={lv} aria-valuemin={0} aria-valuemax={100} onPointerDown={slideLv}
          tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const v = Math.max(0, Math.min(100, lv + (e.key === 'ArrowRight' ? 10 : -10))); preview(dev.id, { lv: v }, `${v} %`); run('setLevel', { percent: v }); } }}>
          <div className="st-fill" /><span className="st-pct">{lv}%</span>
        </div>
        <div className="st-chips">
          {SCENES.map(s => <button key={s.key} className={`st-chip scene ${activeScene === s.key ? 'on' : ''}`} title={s.label} aria-label={s.label} onClick={() => scene(s)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d={s.icon} /></svg>{big && <span>{s.label}</span>}</button>)}
          {has('setColor') && ['pink', 'purple'].map(c => <button key={c} className={`st-chip pill ${hex === COLORS[c] ? 'on' : ''}`} style={{ background: COLORS[c] }} aria-label={c} title={c} onClick={() => paint(c)} />)}
          {has('setColor') && <button className={`st-chip more ${more ? 'on' : ''}`} aria-label="More colours" onClick={() => setMore(!more)}>+</button>}
        </div>
        {has('setColor') && (more || big) && (
          <div className="st-colors">
            <div className="st-hue" ref={ring} onPointerDown={slideHue} title="Slide to try colours in the room" />
            <div className="st-swatches">{Object.keys(COLORS).map(c => <button key={c} className={hex === COLORS[c] ? 'on' : ''} style={{ background: COLORS[c] }} aria-label={c} onClick={() => paint(c)} />)}
              <button className="white" aria-label="White" onClick={() => scene(SCENES[2])} /></div>
          </div>
        )}
      </>}

      {kind === 'switch' && dev.online && (
        <button className={`st-switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={dev.name} onClick={toggle}><i /></button>
      )}

      {kind === 'shade' && dev.online && (
        <div className="st-shade">
          <small>Open</small>
          <div className={`st-roller ${big ? 'tall' : ''}`} ref={shade} onPointerDown={slidePos} role="slider" aria-label="Shade open" aria-valuenow={pos}>
            <div className="st-window" /><div className="st-cloth" style={{ [big ? 'height' : 'width']: `${100 - pos}%` }} /><span className="st-pct">{pos}% open</span>
          </div>
          <div className="st-chips">
            {has('open') && <button className="st-chip" onClick={() => { preview(dev.id, { pos: 100 }, 'Open'); run('open'); }}>Open</button>}
            {has('close') && <button className="st-chip" onClick={() => { preview(dev.id, { pos: 0 }, 'Closed'); run('close'); }}>Close</button>}
          </div>
          {big && <small className="muted">The blinds switch comes on by itself when the shade moves.</small>}
        </div>
      )}
      {!dev.online && <div className="st-offline">Not responding · hotel staff have been told</div>}
    </div>
  );
}

/** The state line the SmartThings app shows for a device (the guest side panel shows states only). */
export function stStatus(dev: StDev) {
  if (!dev.online) return 'Offline';
  const r = { ...dev.readings, ...(dev.overrides ?? {}) } as Record<string, unknown>;
  if (dev.st?.kind === 'shade') { const p = Math.round(num(r.pos, 100)); return p >= 98 ? 'Open' : p <= 2 ? 'Closed' : `${p}% open`; }
  if (dev.type === 'light') { const lv = Math.round(num(r.lv, 0)); if (lv <= 0) return 'Off'; return dev.st?.kind === 'color' ? `On · ${lv}%${typeof r.col === 'string' && r.col ? ' · colour' : ''}` : 'On'; }
  return r.on === true || r.on === 'true' ? 'On' : 'Off';
}
