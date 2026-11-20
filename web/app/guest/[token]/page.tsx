'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import TwinView from '@/components/TwinView';
import { DeviceIcon } from '@/components/DevicePalette';
import DeviceControls, { CMD_LABEL, type Cmd } from '@/components/DeviceControls';
import GuestAssistant from '@/components/GuestAssistant';
import { send, type FromRenderer } from '@/lib/bridge';

type Dev = { id: string; type: string; label: string; name: string; health: string; online: boolean; readings: Record<string, unknown>; overrides: Record<string, unknown>; status: { name: string; value: string; health: string }[]; finding: { title: string; lvl: string } | null; commands: Cmd[] };
type View = { room: { key: string; name: string }; entrance: { key: string; name: string } | null; entrances: { key: string; name: string }[]; title: string; guestName: string; allowUnlock: boolean; expiresAt: number; devices: Dev[] };
type Walk = { phase: 'loading' | 'walking' | 'arrived'; from?: string; to?: string; metres?: number; here?: string };

// What the guided tour says about each kind of device (only devices in the room, only controls it has).
const TOUR: Record<string, string> = {
  ac: 'This is the air conditioner. Tap it to change the temperature, mode, fan speed or louver.',
  light: 'These are the room lights. You can change their brightness and colour.',
  tv: 'This is the TV. Turn it on or off, change the volume or the source.',
  blinds: 'These are the window blinds. Open them for daylight or close them for privacy.',
  fan: 'This is the fan. Choose a speed and let it sweep the room.',
  purifier: 'This is the air purifier. Its ring shows the air quality: blue is clean.',
  vacuum: 'This robot vacuum can clean the room while you are out.',
  lock: 'This is your door lock.',
  fridge: 'This is the minibar.',
  temphum: 'This sensor shows the room temperature and humidity.',
};

/** What a guest sees after scanning a room's QR code: check-in PIN, a walk from the entrance to the room in
 *  3D (or a view of the way from above), a guided tour of the room's devices, the controls each device
 *  supports, and an assistant that takes typed or spoken requests. Everything comes from
 *  /api/guest/<token>/..., which only ever returns this room. */
export default function GuestPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<View | null>(null);
  const [denied, setDenied] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState('');
  const [walk, setWalk] = useState<Walk>({ phase: 'loading' });
  const [ready, setReady] = useState(false);
  const [built, setBuilt] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [tab, setTab] = useState<'room' | 'assistant'>('room');
  const [tour, setTour] = useState<number | null>(null);
  const [overview, setOverview] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(async () => {
    const r = await fetch(`/api/guest/${token}`, { cache: 'no-store' });
    const d = await r.json();
    if (r.status === 401 && d.verify) { setNeedPin(true); return; }
    if (!r.ok) { setDenied(d.error ?? 'This guest link can’t be used.'); return; }
    setNeedPin(false); setView(d);
  }, [token]);
  useEffect(() => { load(); const h = setInterval(load, 2000); return () => clearInterval(h); }, [load]);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault(); setPinErr('');
    const r = await fetch(`/api/guest/${token}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    const d = await r.json();
    if (!r.ok) { if (r.status === 410) setDenied(d.error); else setPinErr(d.error); return; }
    load();
  };

  const onEvent = useCallback((m: FromRenderer) => {
    if (m.type === 'ready') setReady(true);
    if (m.type === 'floorBuilt') setBuilt(true);
    if (m.type === 'guestDenied') setDenied('This guest link is no longer valid.');
    if (m.type === 'walk') {
      if (m.guest === 'walking') setWalk({ phase: 'walking', from: m.from, to: m.to, metres: m.metres });
      else if (m.guest === 'arrived') { setWalk(w => ({ ...w, phase: 'arrived', here: m.roomName })); setOverview(false); }
      else if (m.roomName) setWalk(w => ({ ...w, here: m.roomName }));
    }
    if (m.type === 'deviceClicked') { setFocus(m.id); setTab('room'); setTimeout(() => cards.current[m.id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); }
  }, []);

  const run = (id: string) => async (command: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`/api/guest/${token}/devices/${id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args }) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? { text: `${CMD_LABEL[command] ?? command} · done`, bad: false } : { text: d.error ?? 'That didn’t work', bad: true });
    setTimeout(() => setMsg(null), 2600);
    send({ type: 'refreshDevices' });
    load();
  };

  // the tour visits each device with something to say about it, in a sensible order
  const stops = useMemo(() => {
    const order = ['ac', 'light', 'tv', 'blinds', 'fan', 'purifier', 'vacuum', 'fridge', 'lock', 'temphum'];
    const seen = new Set<string>();
    return (view?.devices ?? []).filter(d => TOUR[d.type] && !seen.has(d.type) && seen.add(d.type)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }, [view]);
  useEffect(() => {
    if (tour == null || !stops[tour]) return;
    const d = stops[tour];
    send({ type: 'walk', action: 'look', id: d.id });
    setFocus(d.id); setTab('room');
    setTimeout(() => cards.current[d.id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }, [tour, stops]);

  if (denied) return (
    <main className="guest-denied"><div className="glass"><span className="logo" /><h2>Guest access</h2><p>{denied}</p><p className="muted">Please ask the front desk for a new QR code.</p></div></main>
  );
  if (needPin) return (
    <main className="guest-denied">
      <form className="glass pin-card" onSubmit={verify}>
        <span className="logo" />
        <h2>Welcome</h2>
        <p className="muted">Enter the 6-digit check-in PIN the front desk gave you.</p>
        <input className="pin" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} aria-label="Check-in PIN" autoFocus />
        {pinErr && <div className="bad-text">{pinErr}</div>}
        <button className="pri" disabled={pin.length < 6}>Continue</button>
      </form>
    </main>
  );

  return (
    <main className="guest">
      <header className="guest-top">
        <span className="logo" />
        <div className="guest-title"><small>{view?.guestName ? `Welcome, ${view.guestName}` : 'Guest access'}{view?.title ? ` · ${view.title}` : ''}</small><b>{view?.room.name ?? '…'}</b></div>
        {view && <span className="muted guest-until">until {new Date(view.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
      </header>
      <section className="guest-stage">
        {view && <TwinView onEvent={onEvent} ready={ready && built} src={`/godot/index.html?guest=${encodeURIComponent(token)}`} loadingText="Preparing the way to your room…" />}
        {walk.phase === 'walking' && (
          <div className="guest-walk glass">
            <span className="walk-dot" />
            <span><b>Walking to {walk.to}</b><small>from {walk.from}{walk.metres ? ` · ${Math.round(walk.metres)} m` : ''}{walk.here && walk.here !== walk.to ? ` · now in ${walk.here}` : ''}</small></span>
            <select aria-label="Start from" value="" onChange={e => { if (e.target.value) { send({ type: 'walk', action: 'restart', from: e.target.value }); setOverview(false); } }}>
              <option value="">Start from…</option>
              {view?.entrances.map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
            <button className={overview ? 'on' : ''} onClick={() => { send({ type: 'walk', action: 'overview', on: !overview }); setOverview(!overview); }}>{overview ? 'Back to walking' : 'See the way from above'}</button>
            <button onClick={() => send({ type: 'walk', action: 'skip' })}>Skip</button>
          </div>
        )}
        {walk.phase === 'arrived' && tour == null && (
          <div className="guest-walk glass arrived">
            <span className="walk-dot" />
            <span><b>You’re in {view?.room.name}</b><small>Drag to look around · tap the floor to move · tap a device for its controls</small></span>
            {stops.length > 0 && <button className="pri" onClick={() => setTour(0)}>Take the tour</button>}
          </div>
        )}
        {tour != null && stops[tour] && (
          <div className="tour glass">
            <small>{tour + 1} of {stops.length}</small>
            <p>{TOUR[stops[tour].type]}</p>
            <div className="row">
              <button disabled={tour === 0} onClick={() => setTour(tour - 1)}>Back</button>
              {tour < stops.length - 1 ? <button className="pri" onClick={() => setTour(tour + 1)}>Next</button> : <button className="pri" onClick={() => { setTour(null); send({ type: 'clearHighlight' }); }}>Done</button>}
              <button className="ghost" onClick={() => { setTour(null); send({ type: 'clearHighlight' }); }}>End tour</button>
            </div>
          </div>
        )}
      </section>
      <aside className="guest-panel">
        <div className="tabs"><button className={tab === 'room' ? 'on' : ''} onClick={() => setTab('room')}>Room controls <i>{view?.devices.length ?? 0}</i></button><button className={tab === 'assistant' ? 'on' : ''} onClick={() => setTab('assistant')}>Assistant</button></div>
        {tab === 'assistant' ? <GuestAssistant token={token} onUi={a => { if (a.type === 'highlight' && a.ids) send({ type: 'highlight', ids: a.ids }); }} /> : (
          <div className="guest-devs">
            {view && view.devices.length === 0 && <div className="muted pad">This room has no connected devices.</div>}
            {view?.devices.map(d => (
              <div key={d.id} ref={el => { cards.current[d.id] = el; }} className={`guest-dev ${focus === d.id ? 'on' : ''} ${d.online ? '' : 'offline'}`} onClick={() => { setFocus(d.id); send({ type: 'walk', action: 'look', id: d.id }); }}>
                <div className="guest-dev-head">
                  <span className="dev-ico"><DeviceIcon type={d.type} size={18} /></span>
                  <span className="dev-txt"><b>{d.name}</b><small>{d.label} · {d.id}</small></span>
                  {d.online ? <i className={`dot ${d.health}`} /> : <em className="off-tag">Offline</em>}
                </div>
                {!d.online && <div className="guest-finding fault">Not responding. Hotel staff have been alerted.</div>}
                {d.online && d.finding && d.health !== 'ok' && <div className={`guest-finding ${d.finding.lvl}`}>{d.finding.title}</div>}
                <div className="guest-status">{d.status.map(s => <span key={s.name}><small>{s.name}</small>{s.value}</span>)}</div>
                {d.commands.length > 0 && <div onClick={e => e.stopPropagation()}><DeviceControls dev={d} commands={d.commands} run={run(d.id)} disabled={!d.online} /></div>}
              </div>
            ))}
          </div>
        )}
        {msg && <div className={`toast ${msg.bad ? 'bad' : 'ok'} guest-toast`}>{msg.text}</div>}
      </aside>
    </main>
  );
}
