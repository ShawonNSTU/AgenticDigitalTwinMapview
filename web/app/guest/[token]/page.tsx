'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import TwinView from '@/components/TwinView';
import { DeviceIcon } from '@/components/DevicePalette';
import { send, type FromRenderer } from '@/lib/bridge';

type Cmd = { name: string; args: Record<string, [number, number] | string[]> };
type Dev = { id: string; type: string; label: string; name: string; health: string; readings: Record<string, unknown>; overrides: Record<string, unknown>; status: { name: string; value: string; health: string }[]; finding: { title: string; lvl: string } | null; commands: Cmd[] };
type View = { room: { key: string; name: string }; entrance: { key: string; name: string } | null; title: string; expiresAt: number; devices: Dev[] };
type Walk = { phase: 'loading' | 'walking' | 'arrived'; from?: string; to?: string; metres?: number; here?: string };

// reading that shows a command's current value
const VALUE_KEY: Record<string, string> = { power: 'on', setTemperature: 'set', setFanSpeed: 'fan', setLevel: 'lv', setPosition: 'pos', setFan: 'fan' };
const CMD_LABEL: Record<string, string> = { power: 'Power', setTemperature: 'Temperature', setFanSpeed: 'Fan speed', setLevel: 'Brightness', setPosition: 'Open', setFan: 'Fan level', lock: 'Lock the door', start: 'Start cleaning', dock: 'Send to dock' };

/** What a guest sees after scanning a room's QR code: a walk from the entrance to the room in 3D, then
 *  that room's devices to watch and control. Everything comes from /api/guest/<token>/..., which only
 *  ever returns this room. */
export default function GuestPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<View | null>(null);
  const [denied, setDenied] = useState('');
  const [walk, setWalk] = useState<Walk>({ phase: 'loading' });
  const [ready, setReady] = useState(false);
  const [built, setBuilt] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(async () => {
    const r = await fetch(`/api/guest/${token}`, { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) { setDenied(d.error ?? 'This guest link can’t be used.'); return; }
    setView(d);
  }, [token]);
  useEffect(() => { load(); const h = setInterval(load, 2000); return () => clearInterval(h); }, [load]);

  const onEvent = useCallback((m: FromRenderer) => {
    if (m.type === 'ready') setReady(true);
    if (m.type === 'floorBuilt') setBuilt(true);
    if (m.type === 'guestDenied') setDenied('This guest link is no longer valid.');
    if (m.type === 'walk') {
      if (m.guest === 'walking') setWalk({ phase: 'walking', from: m.from, to: m.to, metres: m.metres });
      else if (m.guest === 'arrived') setWalk(w => ({ ...w, phase: 'arrived', here: m.roomName }));
      else if (m.roomName) setWalk(w => ({ ...w, here: m.roomName }));
    }
    if (m.type === 'deviceClicked') { setFocus(m.id); cards.current[m.id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }, []);

  const run = async (id: string, command: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`/api/guest/${token}/devices/${id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args }) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? { text: `${CMD_LABEL[command] ?? command} · done`, bad: false } : { text: d.error ?? 'That didn’t work', bad: true });
    setTimeout(() => setMsg(null), 2500);
    load();
  };

  if (denied) return (
    <main className="guest-denied">
      <div className="glass">
        <span className="logo" />
        <h2>Guest access</h2>
        <p>{denied}</p>
        <p className="muted">Ask your host for a new QR code.</p>
      </div>
    </main>
  );

  return (
    <main className="guest">
      <header className="guest-top">
        <span className="logo" />
        <div className="guest-title"><small>Guest access{view?.title ? ` · ${view.title}` : ''}</small><b>{view?.room.name ?? '…'}</b></div>
        {view && <span className="muted guest-until">until {new Date(view.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
      </header>
      <section className="guest-stage">
        <TwinView onEvent={onEvent} ready={ready && built} src={`/godot/index.html?guest=${encodeURIComponent(token)}`} loadingText="Preparing the way to your room…" />
        {walk.phase === 'walking' && (
          <div className="guest-walk glass">
            <span className="walk-dot" />
            <span><b>Walking to {walk.to}</b><small>from {walk.from}{walk.metres ? ` · ${Math.round(walk.metres)} m` : ''}{walk.here && walk.here !== walk.to ? ` · now in ${walk.here}` : ''}</small></span>
            <button onClick={() => send({ type: 'walk', action: 'skip' })}>Skip</button>
          </div>
        )}
        {walk.phase === 'arrived' && (
          <div className="guest-walk glass arrived">
            <span className="walk-dot" />
            <span><b>You’re in {view?.room.name}</b><small>Drag to look around · tap the floor to move · tap a device to find its controls</small></span>
          </div>
        )}
      </section>
      <aside className="guest-panel">
        <div className="guest-panel-head"><b>Devices in this room</b><span className="muted">{view?.devices.length ?? 0}</span></div>
        {view && view.devices.length === 0 && <div className="muted pad">This room has no SmartThings devices.</div>}
        {view?.devices.map(d => (
          <div key={d.id} ref={el => { cards.current[d.id] = el; }} className={`guest-dev ${focus === d.id ? 'on' : ''}`} onClick={() => { setFocus(d.id); send({ type: 'highlight', ids: [d.id] }); }}>
            <div className="guest-dev-head">
              <span className="dev-ico"><DeviceIcon type={d.type} size={18} /></span>
              <span className="dev-txt"><b>{d.label}</b><small>{d.id}</small></span>
              <i className={`dot ${d.health}`} />
            </div>
            {d.finding && d.health !== 'ok' && <div className={`guest-finding ${d.finding.lvl}`}>{d.finding.title}</div>}
            <div className="guest-status">{d.status.map(s => <span key={s.name}><small>{s.name}</small>{s.value}</span>)}</div>
            {d.commands.length > 0 && <div className="guest-ctrls" onClick={e => e.stopPropagation()}>{d.commands.map(c => <Control key={c.name} dev={d} cmd={c} run={run} />)}</div>}
          </div>
        ))}
        {msg && <div className={`toast ${msg.bad ? 'bad' : 'ok'} guest-toast`}>{msg.text}</div>}
      </aside>
    </main>
  );
}

function Control({ dev, cmd, run }: { dev: Dev; cmd: Cmd; run: (id: string, c: string, a?: Record<string, unknown>) => void }) {
  const key = VALUE_KEY[cmd.name];
  const cur = key ? (dev.overrides[key] ?? dev.readings[key]) : undefined;
  const [arg, rule] = Object.entries(cmd.args)[0] ?? [];
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const label = CMD_LABEL[cmd.name] ?? cmd.name;
  if (!arg) return <button onClick={() => run(dev.id, cmd.name)}>{label}</button>;
  if (Array.isArray(rule) && typeof rule[0] === 'string') {
    const on = cur === true || cur === 'true';
    return (
      <label className="ctrl-row"><span>{label}</span>
        <button className={`tgl ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={() => run(dev.id, cmd.name, { [arg]: on ? 'false' : 'true' })}><i /></button>
      </label>
    );
  }
  const [lo, hi] = rule as [number, number];
  const val = draft ?? (typeof cur === 'number' ? cur : Number(cur ?? lo));
  if (cmd.name === 'setTemperature') return (
    <div className="ctrl-row"><span>{label}</span>
      <div className="stepper">
        <button aria-label="Cooler" onClick={() => run(dev.id, cmd.name, { [arg]: Math.max(lo, Math.round(val) - 1) })}>−</button>
        <b>{Math.round(val)} °C</b>
        <button aria-label="Warmer" onClick={() => run(dev.id, cmd.name, { [arg]: Math.min(hi, Math.round(val) + 1) })}>+</button>
      </div>
    </div>
  );
  if (hi - lo <= 5) return (
    <div className="ctrl-row"><span>{label}</span>
      <div className="seg">{Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map(v => <button key={v} className={Math.round(val) === v ? 'on' : ''} onClick={() => run(dev.id, cmd.name, { [arg]: v })}>{v}</button>)}</div>
    </div>
  );
  return (
    <label className="ctrl-row slider"><span>{label} <b>{Math.round(val)}%</b></span>
      <input type="range" min={lo} max={hi} value={Math.round(val)} onChange={e => {
        const v = +e.target.value; setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { run(dev.id, cmd.name, { [arg]: v }); setTimeout(() => setDraft(null), 1500); }, 350);
      }} />
    </label>
  );
}
