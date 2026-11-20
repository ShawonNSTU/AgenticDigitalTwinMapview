'use client';
// A guest's control for one device, pinned next to the device in the 3D room. Each kind of device gets a
// control that looks and moves like the real thing: a climate dial for the AC, a light beam for a bulb, a
// roller you pull for blinds and the projector screen, a remote for the TV, a speed ring for the purifier and
// a hold-to-unlock ring for the door. While a control is dragged the renderer shows the result in the room at
// once (preview: the light dims, the screen rolls down, the AC air changes colour); the command is sent when
// the guest lets go. Only commands the device reports are offered.
import { useEffect, useRef, useState } from 'react';
import { send } from '@/lib/bridge';
import DeviceControls, { type Cmd, type Run } from '@/components/DeviceControls';

export type HoloDev = { id: string; type: string; name: string; label: string; online: boolean; readings: Record<string, unknown>; overrides: Record<string, unknown>; commands: Cmd[] };
type Anchor = { x: number; y: number; visible: boolean } | null;

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : v != null && !isNaN(Number(v)) ? Number(v) : d);
const isOn = (v: unknown) => v === true || v === 'true';
const range = (c: Cmd | undefined, d: [number, number]): [number, number] => { const r = c ? Object.values(c.args)[0] : null; return Array.isArray(r) && typeof r[0] === 'number' ? r as [number, number] : d; };
const argName = (c: Cmd | undefined, d: string) => (c ? Object.keys(c.args)[0] ?? d : d);

export default function HoloControl({ dev, anchor, run, onClose, lockNote }: { dev: HoloDev; anchor: Anchor; run: Run; onClose: () => void; lockNote?: string }) {
  const cmd = (n: string) => dev.commands.find(c => c.name === n);
  const val = (k: string) => dev.overrides?.[k] ?? dev.readings[k];
  const preview = (readings: Record<string, unknown>, text?: string) => send({ type: 'preview', id: dev.id, readings, text });
  // small movements of the device on screen (the walker's sway, rounding) don't move the panel
  const pinned = useRef<Anchor>(null);
  if (anchor && anchor.visible && (!pinned.current || Math.hypot(anchor.x - pinned.current.x, anchor.y - pinned.current.y) > 0.025)) pinned.current = anchor;
  if (!anchor || !anchor.visible) pinned.current = null;
  const a = pinned.current;
  // the panel follows the device while the camera settles, but holds still while the guest is touching it,
  // and keeps the side it opened on (it would otherwise jump across the device as the view turns)
  const side = useRef<boolean | null>(null);
  const held = useRef(false);
  const last = useRef<React.CSSProperties | null>(null);
  useEffect(() => { side.current = null; last.current = null; pinned.current = null; }, [dev.id]);
  useEffect(() => { const up = () => { held.current = false; }; window.addEventListener('pointerup', up); return () => window.removeEventListener('pointerup', up); }, []);
  if (a && side.current == null) side.current = a.x < 0.55;
  const right = side.current ?? true;
  let style: React.CSSProperties = a
    ? { left: `calc(${(a.x * 100).toFixed(1)}% + ${right ? 34 : -34}px)`, top: `clamp(12px, calc(${(a.y * 100).toFixed(1)}% - 150px), calc(100% - 360px))`, transform: right ? 'none' : 'translateX(-100%)' }
    : last.current ?? { right: 16, top: 72 };
  if (held.current && last.current) style = last.current; else last.current = style;

  let body: React.ReactNode;
  if (!dev.online) body = <p className="holo-off">Not responding. Hotel staff have been alerted.</p>;
  else if (dev.type === 'ac' && cmd('setTemperature')) body = <ClimateDial dev={dev} val={val} cmd={cmd} run={run} preview={preview} />;
  else if (dev.type === 'light' && cmd('setLevel')) body = <LightBeam val={val} cmd={cmd} run={run} preview={preview} />;
  else if (dev.type === 'blinds' && cmd('setPosition')) body = <Roller val={val} cmd={cmd} run={run} preview={preview} projector={/projector/i.test(dev.name)} />;
  else if (dev.type === 'tv' && cmd('power')) body = <Remote val={val} cmd={cmd} run={run} preview={preview} />;
  else if ((dev.type === 'purifier' || dev.type === 'fan') && cmd('power')) body = <SpeedRing dev={dev} val={val} cmd={cmd} run={run} preview={preview} />;
  else if (dev.type === 'lock') body = <LockRing val={val} cmd={cmd} run={run} note={lockNote} />;
  else if (dev.commands.length) body = <DeviceControls dev={dev} commands={dev.commands} run={run} />;
  else body = <p className="holo-off">{Object.entries(dev.readings).filter(([k]) => ['temp', 'hum', 'motion', 'on'].includes(k)).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || 'Nothing to control.'}</p>;

  return (
    <>
      {a && <span className="holo-pin" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }} />}
      <div className={`holo glass ${right ? 'r' : 'l'}`} style={style} role="dialog" aria-label={`${dev.name} controls`} onPointerDownCapture={() => { held.current = true; }}>
        <header><b>{dev.name}</b><small>{dev.label}</small><button className="hint-close" aria-label="Close" onClick={onClose}>✕</button></header>
        {body}
      </div>
    </>
  );
}

type P = { val: (k: string) => unknown; cmd: (n: string) => Cmd | undefined; run: Run; preview: (r: Record<string, unknown>, t?: string) => void };

/** Angle (degrees, 0 = up, clockwise) of a pointer around an element's centre. */
function angleOf(e: React.PointerEvent | PointerEvent, el: Element) {
  const b = el.getBoundingClientRect();
  return (Math.atan2(e.clientX - (b.left + b.width / 2), -(e.clientY - (b.top + b.height / 2))) * 180) / Math.PI;
}
/** SVG arc path on a circle, from a0 to a1 degrees (0 = up, clockwise). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const SWEEP = 135; // dials run from -135° to +135°

function useDrag(onMove: (e: PointerEvent) => void, onEnd: () => void) {
  const live = useRef(false);
  useEffect(() => {
    const mv = (e: PointerEvent) => { if (live.current) onMove(e); };
    const up = () => { if (live.current) { live.current = false; onEnd(); } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  });
  return () => { live.current = true; };
}

function PowerButton({ on, onClick, label = 'Power' }: { on: boolean; onClick: () => void; label?: string }) {
  return <button className={`holo-power ${on ? 'on' : ''}`} aria-label={label} aria-pressed={on} onClick={onClick}><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg></button>;
}

const MODE_COL: Record<string, string> = { cool: '#4ea8ff', heat: '#ff8a3d', dry: '#d6b84e', fan: '#9fb3c8', auto: '#7ee2a8' };

function ClimateDial({ dev, val, cmd, run, preview }: P & { dev: HoloDev }) {
  const c = cmd('setTemperature')!;
  const [lo, hi] = range(c, [16, 30]);
  const on = isOn(val('on'));
  const mode = String(val('mode') ?? 'cool');
  const [draft, setDraft] = useState<number | null>(null);
  const t = draft ?? Math.round(num(val('set'), 24));
  const ref = useRef<SVGSVGElement>(null);
  const toT = (ang: number) => Math.round(lo + ((Math.max(-SWEEP, Math.min(SWEEP, ang)) + SWEEP) / (2 * SWEEP)) * (hi - lo));
  const start = useDrag(e => { const v = toT(angleOf(e, ref.current!)); setDraft(v); preview({ set: v, on: true }, `${v}°C`); },
    () => { setDraft(d => { if (d != null) run('setTemperature', { [argName(c, 'celsius')]: d }); return null; }); });
  const ang = -SWEEP + ((t - lo) / (hi - lo || 1)) * 2 * SWEEP;
  const kx = 100 + 78 * Math.sin((ang * Math.PI) / 180), ky = 100 - 78 * Math.cos((ang * Math.PI) / 180);
  const modes = (cmd('setMode') ? Object.values(cmd('setMode')!.args)[0] : []) as string[];
  const fanC = cmd('setFanSpeed');
  const fan = num(val('fan'), 50);
  return (
    <div className="holo-ac">
      <svg ref={ref} viewBox="0 0 200 200" className={`dial ${on ? '' : 'dim'}`} onPointerDown={e => { e.preventDefault(); start(); const v = toT(angleOf(e, ref.current!)); setDraft(v); preview({ set: v, on: true }, `${v}°C`); }}>
        <defs><linearGradient id="tgrad" x1="0" x2="1"><stop offset="0" stopColor="#4ea8ff" /><stop offset="0.5" stopColor="#c8d6e8" /><stop offset="1" stopColor="#ff8a3d" /></linearGradient>
          <radialGradient id="glow"><stop offset="0.55" stopColor={MODE_COL[mode] ?? '#4ea8ff'} stopOpacity="0.32" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient></defs>
        <circle cx="100" cy="100" r="96" fill="url(#glow)" />
        <path d={arc(100, 100, 78, -SWEEP, SWEEP)} stroke="rgba(255,255,255,0.12)" strokeWidth="14" fill="none" strokeLinecap="round" />
        <path d={arc(100, 100, 78, -SWEEP, Math.max(-SWEEP + 0.5, ang))} stroke="url(#tgrad)" strokeWidth="14" fill="none" strokeLinecap="round" />
        {Array.from({ length: hi - lo + 1 }, (_, i) => { const a2 = -SWEEP + (i / (hi - lo)) * 2 * SWEEP, r0 = 62, r1 = i % 2 ? 65 : 68; return <line key={i} x1={100 + r0 * Math.sin(a2 * Math.PI / 180)} y1={100 - r0 * Math.cos(a2 * Math.PI / 180)} x2={100 + r1 * Math.sin(a2 * Math.PI / 180)} y2={100 - r1 * Math.cos(a2 * Math.PI / 180)} stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" />; })}
        <circle cx={kx} cy={ky} r="11" fill="#fff" stroke={MODE_COL[mode] ?? '#4ea8ff'} strokeWidth="3" className="knob" />
        <text x="100" y="104" textAnchor="middle" className="big">{t}°</text>
        <text x="100" y="128" textAnchor="middle" className="sub">{on ? `room ${num(dev.readings.room, t).toFixed(1)}°` : 'off'}</text>
      </svg>
      <div className="holo-row">
        <PowerButton on={on} onClick={() => { preview({ on: !on }, on ? 'Off' : 'On'); run('power', { [argName(cmd('power'), 'on')]: on ? 'false' : 'true' }); }} />
        {modes.map(m => <button key={m} className={`chip ${mode === m ? 'on' : ''}`} style={{ ['--c' as string]: MODE_COL[m] ?? '#9fb3c8' }} onClick={() => { preview({ mode: m, on: true }, m); run('setMode', { mode: m }); }}>{m}</button>)}
      </div>
      {fanC && <div className="holo-fan" aria-label="Fan speed">{[20, 40, 60, 80, 100].map((p, i) => <button key={p} className={fan >= p - 10 ? 'on' : ''} style={{ height: 8 + i * 5 }} aria-label={`Fan ${p}%`} onClick={() => { preview({ fan: p }, `Fan ${p}%`); run('setFanSpeed', { [argName(fanC, 'percent')]: p }); }} />)}<small>fan</small></div>}
    </div>
  );
}

const kelvinCol = (k: number) => { const f = Math.max(0, Math.min(1, (k - 2700) / 3800)); const mix = (a: number, b: number) => Math.round(a + (b - a) * f); return `rgb(${mix(255, 220)},${mix(196, 234)},${mix(130, 255)})`; };

function LightBeam({ val, cmd, run, preview }: P) {
  const c = cmd('setLevel')!, ctC = cmd('setColorTemperature');
  const on = val('on') === undefined ? num(val('lv'), 0) > 0 : isOn(val('on'));
  const [draft, setDraft] = useState<number | null>(null);
  const [ctDraft, setCt] = useState<number | null>(null);
  const lv = draft ?? (on ? Math.round(num(val('lv'), 0)) : 0);
  const ct = ctDraft ?? num(val('ct'), 3000);
  const ref = useRef<HTMLDivElement>(null);
  const ctRef = useRef<HTMLDivElement>(null);
  const [ctLo, ctHi] = range(ctC, [2700, 6500]);
  const fromY = (e: PointerEvent | React.PointerEvent) => { const b = ref.current!.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(100, (1 - (e.clientY - b.top) / b.height) * 100))); };
  const fromX = (e: PointerEvent | React.PointerEvent) => { const b = ctRef.current!.getBoundingClientRect(); return Math.round((ctLo + Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * (ctHi - ctLo)) / 100) * 100; };
  const startLv = useDrag(e => { const v = fromY(e); setDraft(v); preview({ lv: v, on: v > 0 }, `${v} %`); },
    () => setDraft(d => { if (d != null) run('setLevel', { [argName(c, 'percent')]: d }); return null; }));
  const startCt = useDrag(e => { const k = fromX(e); setCt(k); preview({ ct: k }, k < 3500 ? 'Warm' : k < 5000 ? 'Neutral' : 'Daylight'); },
    () => setCt(d => { if (d != null && ctC) run('setColorTemperature', { [argName(ctC, 'kelvin')]: d }); return null; }));
  const col = kelvinCol(ct);
  return (
    <div className="holo-light">
      <div className="beam" ref={ref} style={{ ['--lv' as string]: `${lv}%`, ['--col' as string]: col }}
        onPointerDown={e => { e.preventDefault(); startLv(); const v = fromY(e); setDraft(v); preview({ lv: v, on: v > 0 }, `${v} %`); }}>
        <div className="fill" /><span className="bulb" /><b>{lv}%</b>
      </div>
      <div className="holo-side">
        {cmd('power') && <PowerButton on={on} onClick={() => { preview({ on: !on, lv: on ? 0 : Math.max(lv, 60) }, on ? 'Off' : 'On'); run('power', { [argName(cmd('power'), 'on')]: on ? 'false' : 'true' }); }} />}
        {ctC && <><small>Colour</small><div className="ct" ref={ctRef} onPointerDown={e => { e.preventDefault(); startCt(); const k = fromX(e); setCt(k); preview({ ct: k }); }}>
          <span style={{ left: `${((ct - ctLo) / (ctHi - ctLo || 1)) * 100}%`, background: col }} /></div>
          <small className="muted">{ct < 3500 ? 'Warm' : ct < 5000 ? 'Neutral' : 'Daylight'} · {ct} K</small></>}
        <div className="presets">{[['Relax', 30, 2700], ['Read', 80, 4000], ['Bright', 100, 5500]].map(([n, l, k]) => (
          <button key={n as string} onClick={() => { preview({ lv: l, ct: k, on: true }, n as string); run('setLevel', { [argName(c, 'percent')]: l }); if (ctC) setTimeout(() => run('setColorTemperature', { [argName(ctC, 'kelvin')]: k }), 250); }}>{n}</button>))}</div>
      </div>
    </div>
  );
}

function Roller({ val, cmd, run, preview, projector }: P & { projector: boolean }) {
  const c = cmd('setPosition')!;
  const [draft, setDraft] = useState<number | null>(null);
  const pos = draft ?? Math.round(num(val('pos'), 100)); // 100 = rolled up / open
  const ref = useRef<HTMLDivElement>(null);
  const fromY = (e: PointerEvent | React.PointerEvent) => { const b = ref.current!.getBoundingClientRect(); return Math.round(100 - Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)) * 100); };
  const say = (p: number) => projector ? (p > 90 ? 'Screen up' : p < 10 ? 'Screen down' : `${100 - p}% down`) : `${p}% open`;
  const start = useDrag(e => { const p = fromY(e); setDraft(p); preview({ pos: p }, say(p)); },
    () => setDraft(d => { if (d != null) run('setPosition', { [argName(c, 'percent')]: d }); return null; }));
  return (
    <div className="holo-roller">
      <div className={`window ${projector ? 'proj' : ''}`} ref={ref} onPointerDown={e => { e.preventDefault(); start(); const p = fromY(e); setDraft(p); preview({ pos: p }, say(p)); }}>
        <div className="cloth" style={{ height: `${100 - pos}%` }}><span className="cord" /></div>
      </div>
      <div className="holo-side">
        <b>{say(pos)}</b>
        <small className="muted">Drag the {projector ? 'screen' : 'blind'} up or down</small>
        <div className="presets">
          {cmd('close') && <button onClick={() => { preview({ pos: 0 }, say(0)); run('close'); }}>{projector ? 'Lower' : 'Close'}</button>}
          {cmd('open') && <button onClick={() => { preview({ pos: 100 }, say(100)); run('open'); }}>{projector ? 'Raise' : 'Open'}</button>}
        </div>
      </div>
    </div>
  );
}

function Remote({ val, cmd, run, preview }: P) {
  const on = isOn(val('on'));
  const vol = Math.round(num(val('vol'), 20));
  const input = String(val('input') ?? '');
  const volC = cmd('setVolume'), inC = cmd('setInput');
  const setVol = (v: number) => { const x = Math.max(0, Math.min(100, v)); preview({ vol: x }, `Volume ${x}`); volC && run('setVolume', { [argName(volC, 'percent')]: x }); };
  const sources = (inC ? Object.values(inC.args)[0] : []) as string[];
  return (
    <div className="holo-remote">
      <div className={`screen ${on ? 'on' : ''}`}><span>{on ? input || 'TV' : 'Standby'}</span></div>
      <div className="pad">
        <PowerButton on={on} onClick={() => { preview({ on: !on }, on ? 'Off' : 'On'); run('power', { [argName(cmd('power'), 'on')]: on ? 'false' : 'true' }); }} />
        {volC && <div className="rocker"><button aria-label="Volume up" disabled={!on} onClick={() => setVol(vol + 5)}>+</button><small>VOL {vol}</small><button aria-label="Volume down" disabled={!on} onClick={() => setVol(vol - 5)}>−</button></div>}
      </div>
      {sources.length > 0 && <div className="presets">{sources.map(s => <button key={s} disabled={!on} className={input === s ? 'on' : ''} onClick={() => { preview({ input: s }, s); run('setInput', { source: s }); }}>{s}</button>)}</div>}
    </div>
  );
}

function SpeedRing({ dev, val, cmd, run, preview }: P & { dev: HoloDev }) {
  const on = isOn(val('on'));
  const c = cmd('setFan') ?? cmd('setSpeed');
  const [lo, hi] = range(c, [1, 3]);
  const key = dev.type === 'fan' ? 'speed' : 'fan';
  const lvl = Math.round(num(val(key), lo));
  const n = hi - lo + 1;
  return (
    <div className="holo-speed">
      <svg viewBox="0 0 160 160" className={on ? 'spin' : ''} style={{ ['--dur' as string]: `${Math.max(0.4, 3.2 - lvl * 0.5)}s` }}>
        {Array.from({ length: n }, (_, i) => { const a0 = -150 + i * (300 / n) + 3, a1 = -150 + (i + 1) * (300 / n) - 3; const lit = on && lo + i <= lvl; return (
          <path key={i} d={arc(80, 80, 64, a0, a1)} stroke={lit ? '#5ec8ff' : 'rgba(255,255,255,0.14)'} strokeWidth="12" fill="none" strokeLinecap="round" className="seg"
            onClick={() => { const v = lo + i; preview({ [key]: v, on: true }, `Speed ${v}`); c && run(c.name, { [argName(c, 'level')]: v }); }} />); })}
        <g className="rotor"><circle cx="80" cy="80" r="26" fill="rgba(94,200,255,0.12)" />{[0, 120, 240].map(a => <path key={a} d="M80 80 q 6 -22 0 -24 q -8 6 0 24" fill="rgba(200,230,255,0.75)" transform={`rotate(${a} 80 80)`} />)}</g>
      </svg>
      <div className="holo-row"><PowerButton on={on} onClick={() => { preview({ on: !on }, on ? 'Off' : 'On'); run('power', { [argName(cmd('power'), 'on')]: on ? 'false' : 'true' }); }} /><small className="muted">{on ? `Speed ${lvl} of ${hi}` : 'Off'} · tap a segment</small></div>
    </div>
  );
}

function LockRing({ val, cmd, run, note }: { val: (k: string) => unknown; cmd: (n: string) => Cmd | undefined; run: Run; note?: string }) {
  const locked = val('locked') === undefined ? true : isOn(val('locked'));
  const canUnlock = !!cmd('unlock');
  const [p, setP] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const hold = () => { if (!canUnlock || !locked) return; const t0 = Date.now(); timer.current = setInterval(() => { const k = Math.min(1, (Date.now() - t0) / 1200); setP(k); if (k >= 1) { clearInterval(timer.current); setP(0); run('unlock', {}, true); } }, 30); };
  const release = () => { clearInterval(timer.current); setP(0); };
  return (
    <div className="holo-lock">
      <svg viewBox="0 0 160 160" onPointerDown={hold} onPointerUp={release} onPointerLeave={release} className={canUnlock && locked ? 'hold' : ''}>
        <circle cx="80" cy="80" r="62" stroke="rgba(255,255,255,0.12)" strokeWidth="10" fill="none" />
        {p > 0 && <path d={arc(80, 80, 62, 0, Math.max(1, p * 359.9))} stroke="#7ee2a8" strokeWidth="10" fill="none" strokeLinecap="round" />}
        <g transform="translate(80 84)" fill="none" stroke={locked ? '#e6edf3' : '#7ee2a8'} strokeWidth="5" strokeLinecap="round">
          <rect x="-20" y="-6" width="40" height="32" rx="6" fill={locked ? 'rgba(230,237,243,0.12)' : 'rgba(126,226,168,0.15)'} />
          <path d={locked ? 'M -12 -6 v -10 a 12 12 0 0 1 24 0 v 10' : 'M -12 -6 v -10 a 12 12 0 0 1 24 0 v -2'} />
        </g>
      </svg>
      <b>{locked ? 'Locked' : 'Unlocked'}</b>
      <small className="muted">{canUnlock ? (locked ? 'Press and hold to unlock' : 'Locks again by itself') : note || 'Unlocking is done at the front desk'}</small>
      {!locked && cmd('lock') && <button onClick={() => run('lock')}>Lock now</button>}
    </div>
  );
}
