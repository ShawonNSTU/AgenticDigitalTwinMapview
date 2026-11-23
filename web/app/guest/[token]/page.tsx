'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import TwinView from '@/components/TwinView';
import { DeviceIcon } from '@/components/DevicePalette';
import { CMD_LABEL, type Cmd } from '@/components/DeviceControls';
import HoloControl from '@/components/HoloControl';
import { stStatus, type StProfile } from '@/components/StZone';
import GuestAssistant from '@/components/GuestAssistant';
import GuestJourney from '@/components/GuestJourney';
import Locator from '@/components/Locator';
import ClimateVision, { openClimateVision } from '@/components/ClimateVision';
import FullscreenButton from '@/components/FullscreenButton';
import { SideFold, SideTab, useSideOpen } from '@/components/SidePanel';
import { send, type FromRenderer } from '@/lib/bridge';

type Dev = { id: string; type: string; label: string; name: string; health: string; online: boolean; readings: Record<string, unknown>; overrides: Record<string, unknown>; status: { name: string; value: string; health: string }[]; finding: { title: string; lvl: string } | null; commands: Cmd[]; st?: StProfile };
type View = { lock: { integration: string; autoRelockSec: number }; room: { key: string; name: string }; entrance: { key: string; name: string } | null; entrances: { key: string; name: string }[]; title: string; guestName: string; allowUnlock: boolean; expiresAt: number; devices: Dev[] };
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

// What the tour says about a real SmartThings device, by what it is (lib/sim/stzone.ts ST_PROFILE).
const REAL_TOUR: Record<string, string> = {
  color: 'A real SmartThings colour bulb: turn it on or off, dim it, pick warm or cool white, or a colour.',
  switch: 'A real SmartThings switch: turn it on or off.',
  shade: 'A real SmartThings roller shade: open it, close it, or stop it at any height.',
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
  const [stepFree, setStepFree] = useState(false);   // route without stairs or narrow doorways
  const [ready, setReady] = useState(false);
  const [built, setBuilt] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [tab, setTab] = useState<'stay' | 'room'>('stay');
  const [sideOpen, setSideOpen] = useSideOpen('guest');
  const [tour, setTour] = useState<number | null>(null);
  const [climate, setClimate] = useState(false);
  const [overview, setOverview] = useState(false);
  const [hintShown, setHintShown] = useState(true);   // the "You're in …" card: closable, gone once the tour is over
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  const [route, setRoute] = useState<[number, number][]>([]);
  const [stepUp, setStepUp] = useState<{ id: string; command: string } | null>(null);
  const [stepPin, setStepPin] = useState('');
  const [stepErr, setStepErr] = useState('');
  // the device whose control is pinned beside it in the 3D room, and where it is on screen
  const [holo, setHolo] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ id: string; x: number; y: number; visible: boolean } | null>(null);
  // bring a device's card into view in the side panel, without scrolling the whole page (on a phone the page
  // scrolls, and moving it would take the 3D view off the screen)
  const reveal = useCallback((id: string) => setTimeout(() => {
    const card = cards.current[id], panel = card?.closest('.guest-panel') as HTMLElement | null;
    if (!card || !panel || panel.scrollHeight <= panel.clientHeight + 1) return;
    panel.scrollTo({ top: card.offsetTop - panel.offsetTop - 64, behavior: 'smooth' });
  }, 50), []);
  const openHolo = useCallback((id: string | null) => {
    setHolo(id); setAnchor(null);
    send({ type: 'track', id: id ?? '' });
    if (id) send({ type: 'walk', action: 'look', id }); else send({ type: 'clearHighlight' });
  }, []);
  // remember this guest link on the phone, so a location code scanned with the camera finds the way back here
  useEffect(() => { try { localStorage.setItem('twin.guestToken', token); } catch { /* storage unavailable */ } }, [token]);

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

  const journey = useCallback((body: object) => { fetch(`/api/guest/${token}/journey`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); }, [token]);
  const say = useCallback((text: string, bad = false) => { setMsg({ text, bad }); setTimeout(() => setMsg(null), 3200); }, []);
  const onEvent = useCallback((m: FromRenderer) => {
    if (m.type === 'ready') setReady(true);
    if (m.type === 'floorBuilt') setBuilt(true);
    if (m.type === 'guestDenied') setDenied('This guest link is no longer valid.');
    if (m.type === 'walk') {
      // the walk from the entrance tells the hotel the guest is on the way (and how far), and when they are in
      if (m.guest === 'walking') { setWalk({ phase: 'walking', from: m.from, to: m.to, metres: m.metres }); if (m.route) setRoute(m.route); if (m.metres) journey({ action: 'walking', metres: m.metres }); }
      else if (m.guest === 'arrived') { setWalk(w => ({ ...w, phase: 'arrived', here: m.roomName })); setOverview(false); journey({ action: 'arrived', via: 'walk' }); }
      else if (m.roomName) setWalk(w => ({ ...w, here: m.roomName }));
      // the tour's device is in sight: now its control can appear on it
      if (m.viewing && m.viewing === pendingShow.current) { pendingShow.current = null; inView(m.viewing); }
    }
    if (m.type === 'deviceClicked') { setFocus(m.id); setTab('room'); openHolo(m.id); reveal(m.id); }
    if (m.type === 'anchor') setAnchor(m);
  }, [openHolo, journey, reveal]);

  const run = (id: string) => async (command: string, args: Record<string, unknown> = {}, _c?: boolean, pin?: string) => {
    const r = await fetch(`/api/guest/${token}/devices/${id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args, ...(pin ? { pin } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 428 && d.stepUp) { setStepUp({ id, command }); setStepPin(''); setStepErr(''); return; }   // the policy wants the PIN again
    if (stepUp && !r.ok) { setStepErr(d.error ?? 'That didn’t work'); return; }
    setStepUp(null);
    const what = command === 'unlock' && r.ok ? `Door unlocked${d.relockIn ? ` · locks again in ${d.relockIn} s` : ''}` : `${CMD_LABEL[command] ?? command} · done${d.note ? ` (${d.note})` : ''}`;
    setMsg(r.ok ? { text: what, bad: false } : { text: d.error ?? 'That didn’t work', bad: true });
    setTimeout(() => setMsg(null), 3200);
    send({ type: 'refreshDevices' });
    load();
  };

  // The tour. A room with real SmartThings devices (the SmartThings Experience Zone): it visits every real device,
  // one by one, in the order a person walks the room (shade first, then the ceiling, the spots, the lamps), and says
  // where it is and what it does. Simulated devices are left out. Any other room: one stop per kind of device.
  const stops = useMemo(() => {
    const devs = view?.devices ?? [];
    const real = devs.filter(d => d.st);
    if (real.length) {
      const walk = ['Aqara Roller Shade Controller', 'Blinds Switch', 'TV Lamp', 'Light 1', 'Light 2', 'Light 3', 'Light 4', 'Light 5', 'Desk Lamp', 'Left Window Light', 'Right Window Light', 'side lamp'];
      const at = (n: string) => { const i = walk.indexOf(n); return i < 0 ? 99 : i; };
      return [...real].sort((a, b) => at(a.name) - at(b.name) || a.name.localeCompare(b.name));
    }
    const order = ['ac', 'light', 'tv', 'blinds', 'fan', 'purifier', 'vacuum', 'fridge', 'lock', 'temphum'];
    const seen = new Set<string>();
    return devs.filter(d => TOUR[d.type] && !seen.has(d.type) && seen.add(d.type)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }, [view]);
  // Each stop: first get the device in sight (the renderer walks to a spot that sees it, clear of walls and tall
  // furniture, and turns to it), then show its control on it. A phone has room for the tour card or the control in
  // the 3D view, not both: there the device is highlighted and the control stays one tap away in the list.
  const pendingShow = useRef<string | null>(null);
  const inView = useCallback((id: string) => {
    if (window.matchMedia('(min-width: 600px)').matches) openHolo(id);
    else send({ type: 'highlight', ids: [id] });
  }, [openHolo]);
  // keyed on the stop's device (the room's devices reload every few seconds; that must not restart the stop)
  const stopId = tour != null ? stops[tour]?.id ?? null : null;
  useEffect(() => {
    if (!stopId) return;
    setFocus(stopId); setTab('room'); reveal(stopId);
    openHolo(null);
    pendingShow.current = stopId;
    send({ type: 'walk', action: 'show', id: stopId });
    // an older renderer never answers: show it after a moment anyway
    const t = setTimeout(() => { if (pendingShow.current === stopId) { pendingShow.current = null; inView(stopId); } }, 9000);
    return () => clearTimeout(t);
  }, [stopId, openHolo, reveal, inView]);

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
    <main className={`guest ${sideOpen ? '' : 'side-closed'}`}>
      <header className="guest-top">
        <span className="logo" />
        <div className="guest-title"><small>{view?.guestName ? `Welcome, ${view.guestName}` : 'Guest access'}{view?.title ? ` · ${view.title}` : ''}</small><b>{view?.room.name ?? '…'}</b></div>
        {view && <span className="muted guest-until">until {new Date(view.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
      </header>
      <section className="guest-stage" data-fullscreen>
        <FullscreenButton />
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
            <button className={stepFree ? 'on' : ''} aria-pressed={stepFree} title="Avoid stairs and narrow doorways" onClick={() => { send({ type: 'walk', action: 'stepFree', on: !stepFree }); setStepFree(!stepFree); }}>Step-free</button>
            <button onClick={() => send({ type: 'walk', action: 'skip' })}>Skip</button>
          </div>
        )}
        {walk.phase === 'arrived' && tour == null && hintShown && !holo && (
          <div className="guest-walk glass arrived">
            <span className="walk-dot" />
            <span><b>You’re in {view?.room.name}</b><small>Tap a device to control it</small></span>
            {stops.length > 0 && <button className="pri" onClick={() => { setOverview(false); setTour(0); }}>Take the tour</button>}
            {view?.devices.some(d => d.type === 'ac') && <button onClick={() => { setOverview(false); setClimate(true); setHintShown(false); }} title="See your room's air: heat, airflow and dust">Climate Vision</button>}
            <button className={overview ? 'on' : ''} aria-pressed={overview} onClick={() => { send({ type: 'walk', action: 'overview', on: !overview }); setOverview(!overview); }}>{overview ? 'Back to eye level' : 'See the whole room'}</button>
            <button className="hint-x" aria-label="Close" title="Close" onClick={() => setHintShown(false)}>✕</button>
          </div>
        )}
        {view && !climate && <div className="locator-wrap"><Locator token={token} route={route} roomName={view.room.name}
          onUnlock={(() => { const lock = view.devices.find(d => d.type === 'lock'); return lock && view.allowUnlock ? () => run(lock.id)('unlock') : undefined; })()} /></div>}
        {stepUp && (
          <div className="modal-back" onClick={() => setStepUp(null)}>
            <form className="modal glass pin-card" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); run(stepUp.id)(stepUp.command, {}, true, stepPin); }}>
              <h3>Unlock your door</h3>
              <p className="muted">For your safety, enter your check-in PIN again.</p>
              <input className="pin" inputMode="numeric" maxLength={6} autoFocus value={stepPin} onChange={e => setStepPin(e.target.value.replace(/\D/g, ''))} aria-label="Check-in PIN" />
              {stepErr && <div className="bad-text">{stepErr}</div>}
              <button className="pri" disabled={stepPin.length < 6}>Unlock</button>
            </form>
          </div>
        )}
        {holo && view?.devices.find(d => d.id === holo) && (() => {
          const d = view.devices.find(x => x.id === holo)!;
          return <HoloControl dev={d} anchor={anchor && anchor.id === holo ? anchor : null} run={run(d.id)} onClose={() => openHolo(null)}
            lockNote={view.allowUnlock ? '' : 'Unlocking is done at the front desk'} />;
        })()}
        {climate && view && <ClimateVision room={view.room.key} run={(id, c, a) => run(id)(c, a ?? {})} onClose={() => { setClimate(false); send({ type: 'walk', action: 'overview', on: false }); }} />}
        {tour != null && stops[tour] && (
          <div className="tour glass">
            <small>{tour + 1} of {stops.length}</small>
            {stops[tour].st ? <p><b>{stops[tour].name}</b> · {stops[tour].st!.where}. {REAL_TOUR[stops[tour].st!.kind]}</p> : <p>{TOUR[stops[tour].type]}</p>}
            <div className="row">
              <button disabled={tour === 0} onClick={() => setTour(tour - 1)}>Back</button>
              {tour < stops.length - 1 ? <button className="pri" onClick={() => setTour(tour + 1)}>Next</button> : <button className="pri" onClick={() => { setTour(null); setHintShown(false); openHolo(null); }}>Done</button>}
              <button className="ghost" onClick={() => { setTour(null); setHintShown(false); openHolo(null); }}>End tour</button>
            </div>
          </div>
        )}
        {!sideOpen && <SideTab label={tab === 'room' ? 'Room' : 'Your stay'} count={tab === 'room' ? view?.devices.length : undefined} onOpen={() => setSideOpen(true)} />}
        {view && <GuestAssistant token={token} right={sideOpen ? 380 : 0} onUi={a => { const x = a as any; if (x.type === 'climateVision') { setClimate(true); setHintShown(false); openClimateVision({ smoke: !!x.smoke }); } else if (x.type === 'highlight' && x.ids) send({ type: 'highlight', ids: x.ids }); else if (x.type === 'focusDevice' && x.id) { send({ type: 'focusDevice', id: x.id }); setFocus(x.id); } else if (x.type === 'selectRoom' && x.room) send({ type: 'selectRoom', room: x.room }); else if (x.type === 'setLayer' && ['comfort', 'energy'].includes(x.layer)) send({ type: 'setLayer', layer: x.layer, on: x.on !== false }); }} />}
      </section>
      <aside className="guest-panel" hidden={!sideOpen}>
        <div className="tabs"><button className={tab === 'stay' ? 'on' : ''} onClick={() => setTab('stay')}>Your stay</button><button className={tab === 'room' ? 'on' : ''} onClick={() => setTab('room')}>Room <i>{view?.devices.length ?? 0}</i></button><SideFold onFold={() => setSideOpen(false)} /></div>
        {tab === 'stay' ? <GuestJourney token={token} onMsg={say} /> : (
          <div className="guest-devs">
            {view && view.devices.length === 0 && <div className="muted pad">This room has no connected devices.</div>}
            {view?.devices.map(d => (
              <div key={d.id} ref={el => { cards.current[d.id] = el; }} className={`guest-dev ${focus === d.id ? 'on' : ''} ${holo === d.id ? 'holo-on' : ''} ${d.online ? '' : 'offline'}`} onClick={() => { setFocus(d.id); openHolo(d.id); }}>
                <div className="guest-dev-head">
                  <span className="dev-ico"><DeviceIcon type={d.type} size={18} /></span>
                  <span className="dev-txt"><b>{d.name}</b><small>{d.label} · {d.id}</small></span>
                  {d.online ? <i className={`dot ${d.health}`} /> : <em className="off-tag">Offline</em>}
                </div>
                {!d.online && <div className="guest-finding fault">Not responding. Hotel staff have been alerted.</div>}
                {d.type === 'lock' && view && <div className="muted lock-line">{view.lock.integration === 'smartthings' ? 'Connected lock (SmartThings)' : 'Lock simulator'}{view.allowUnlock ? ` · unlocking needs your PIN; it locks again after ${view.lock.autoRelockSec} s` : ' · unlocking is done at the front desk'}</div>}
                {d.online && d.finding && d.health !== 'ok' && <div className={`guest-finding ${d.finding.lvl}`}>{d.finding.title}</div>}
                {d.st
                  ? <div className="guest-status"><span><small>{d.st.where}</small>{stStatus(d)}</span></div>
                  : <div className="guest-status">{d.status.map(s => <span key={s.name}><small>{s.name}</small>{s.value}</span>)}</div>}
                {d.commands.length > 0 && <button className="holo-open" onClick={e => { e.stopPropagation(); setFocus(d.id); openHolo(holo === d.id ? null : d.id); }}>{holo === d.id ? 'Controlling in the room' : 'Control in the room'}</button>}
              </div>
            ))}
          </div>
        )}
        {msg && <div className={`toast ${msg.bad ? 'bad' : 'ok'} guest-toast`}>{msg.text}</div>}
      </aside>
    </main>
  );
}
