'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TwinView from '@/components/TwinView';
import DevicePanel from '@/components/DevicePanel';
import ChatPanel from '@/components/ChatPanel';
import DevicePalette, { DeviceIcon, type Hover } from '@/components/DevicePalette';
import MapToolbar from '@/components/MapToolbar';
import MapNav from '@/components/MapNav';
import WalkHud from '@/components/WalkHud';
import GuestQr from '@/components/GuestQr';
import { send, RENDERER_VERSION, type FromRenderer } from '@/lib/bridge';

type Sim = { t: number; playing: boolean; scenario: string; scenarios: { key: string; name: string }[] };
type Row = { id: string; type: string; label: string; room: string; name: string; health: string; fault?: string };
type Room = { key: string; name: string; label?: string; zone?: string };
type Toast = { id: number; text: string; kind: 'ok' | 'bad' };

const json = (r: Response) => r.json();
const post = (url: string, method: string, body?: object) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

export default function Home() {
  const [sim, setSim] = useState<Sim | null>(null);
  const [devices, setDevices] = useState<Row[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [floorTitle, setFloorTitle] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'devices' | 'agent'>('devices');
  const [hover, setHover] = useState<Hover>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [moving, setMoving] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [walk, setWalk] = useState<{ on: boolean; room?: string; roomName?: string; note?: string }>({ on: false });
  const [roomSel, setRoomSel] = useState<{ room: string; roomName: string } | null>(null); // a room clicked on the map
  const [qrFor, setQrFor] = useState<{ room: string; roomName: string } | null>(null);
  const [floorShown, setFloorShown] = useState(false);
  const [stale, setStale] = useState(''); // the 3D renderer export is older than this page // the renderer has built the floor (not just started)
  // the "no devices yet" hint can be closed; remembered in this browser
  const [hintClosed, setHintClosed] = useState(false);
  // Tell the renderer which parts of the map the overlays cover, so "fit" keeps the floor clear of them.
  useEffect(() => {
    if (!ready || !stage.current) return;
    const el = stage.current;
    const measure = () => {
      const s = el.getBoundingClientRect();
      const box = (q: string) => el.querySelector(q)?.getBoundingClientRect();
      const pal = box('.palette'), bar = box('.map-toolbar'), nav = box('.map-nav');
      // the palette blocks the left side only where it is tall; collapsed it is just a header
      const left = pal && pal.height > s.height * 0.4 ? pal.right - s.left : 0;
      const top = bar ? bar.bottom - s.top : 0;
      const right = nav ? s.right - nav.left : 0;
      send({ type: 'setInsets', left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: 0 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const pal = el.querySelector('.palette');
    if (pal) ro.observe(pal);
    return () => ro.disconnect();
  }, [ready, walk.on]);
  // nothing selected: the renderer drops the selected device's piping circuit
  useEffect(() => { if (!sel) send({ type: 'focusDevice', id: '' }); }, [sel]);
  useEffect(() => { try { setHintClosed(localStorage.getItem('twin.hintClosed') === '1'); } catch { /* storage unavailable */ } }, []);
  const closeHint = () => { setHintClosed(true); try { localStorage.setItem('twin.hintClosed', '1'); } catch { /* storage unavailable */ } };
  const stage = useRef<HTMLElement>(null);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3800);
  }, []);
  const loadDevices = useCallback(() => fetch('/api/devices').then(json).then(x => setDevices(x.devices)), []);
  const loadRooms = useCallback(() => fetch('/api/building').then(json).then(b => { setRooms(b.rooms); setFloorTitle(b.title ?? ''); }), []);

  // Clock, health and device changes come from the simulated platform over SSE.
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('clock', e => { const s = JSON.parse((e as MessageEvent).data); setSim(s); send({ type: 'setTime', t: s.t }); });
    es.addEventListener('health', () => loadDevices());
    es.addEventListener('devices', () => { loadDevices(); send({ type: 'refreshDevices' }); });
    es.addEventListener('layout', () => { setSel(null); loadDevices(); loadRooms(); });
    loadDevices(); loadRooms();
    return () => es.close();
  }, [loadDevices, loadRooms]);
  useEffect(() => { if (sim) send({ type: 'setScenario', key: sim.scenario }); }, [sim?.scenario]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = useCallback((id: string) => { setSel(id); send({ type: 'focusDevice', id }); }, []);
  const roomName = useCallback((key: string) => { const r = rooms.find(x => x.key === key); return r ? r.name : key === 'out' ? 'Outside' : key; }, [rooms]);

  const onEvent = useCallback(async (m: FromRenderer) => {
    if (m.type === 'ready') { setReady(true); setStale(m.version !== RENDERER_VERSION ? m.version : ''); }
    if (m.type === 'floorBuilt') setFloorShown(true);
    if (m.type === 'deviceClicked') { setSel(m.id); setRoomSel(null); }
    if (m.type === 'roomClicked') setRoomSel(m.room ? { room: m.room, roomName: m.roomName } : null);
    if (m.type === 'partClicked') setSel(m.id);
    if (m.type === 'deviceClosed') setSel(null);
    if (m.type === 'walk') {
      setWalk(w => ({ on: m.on, room: m.room ?? w.room, roomName: m.roomName ?? w.roomName, note: m.note }));
      setRoomSel(null);
      if (m.on) setSel(null);
      if (m.note) setTimeout(() => setWalk(w => ({ ...w, note: undefined })), 3500);
    }
    if (m.type === 'placeHover') setHover({ roomName: m.roomName, valid: m.valid, mount: m.mount });
    if (m.type === 'dropDevice') {
      setHover(null);
      const r = await post('/api/devices', 'POST', { type: m.deviceType, x: m.x, y: m.y, z: m.z, rotationY: m.rotationY, room: m.room === 'out' ? undefined : m.room });
      const d = await r.json();
      if (!r.ok) { toast(d.error ?? 'Could not place the device', 'bad'); return; }
      send({ type: 'refreshDevices' });
      send({ type: 'focusDevice', id: d.id });
      setSel(d.id);
      loadDevices();
      toast(`${d.id} placed · ${d.name.split(' · ')[1] ?? ''}`);
    }
    if (m.type === 'moveDevice') {
      setMoving(null);
      const r = await post(`/api/devices/${m.id}`, 'PATCH', { x: m.x, y: m.y, z: m.z, rotationY: m.rotationY });
      if (!r.ok) { toast('Could not move the device', 'bad'); return; }
      send({ type: 'refreshDevices' });
      send({ type: 'focusDevice', id: m.id });
      loadDevices();
      toast(`${m.id} moved`);
    }
  }, [toast, loadDevices]);

  // hotel: refurnish a room as a guest room (bed set and the usual devices), or every suitable room at once
  const setupRoom = useCallback(async (room?: string) => {
    if (!room && !confirm('Set up every suitable room on this floor as a hotel guest room? Their furniture and devices are replaced.')) return;
    const r = await post('/api/hotel', 'POST', room ? { room } : {});
    const d = await r.json();
    if (!r.ok) { toast(d.error ?? 'Could not set up the room', 'bad'); return; }
    toast(room ? `Guest room ready · ${d.devices.length} devices` : `${d.rooms} guest rooms ready`);
    loadDevices(); loadRooms(); send({ type: 'refreshDevices' });
  }, [toast, loadDevices, loadRooms]);

  const remove = useCallback(async (id: string) => {
    send({ type: 'closeDevice' });
    const r = await post(`/api/devices/${id}`, 'DELETE');
    if (r.ok) { setSel(null); send({ type: 'refreshDevices' }); loadDevices(); toast(`${id} removed`); }
  }, [toast, loadDevices]);
  const move = useCallback((id: string) => { send({ type: 'closeDevice' }); setMoving(id); send({ type: 'startMove', id }); }, []);

  const bad = devices.filter(d => d.health !== 'ok');
  const counts = useMemo(() => devices.reduce<Record<string, number>>((a, d) => { a[d.type] = (a[d.type] ?? 0) + 1; return a; }, {}), [devices]);
  const byRoom = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const d of devices) g.set(d.room, [...(g.get(d.room) ?? []), d]);
    return [...g.entries()].sort((a, b) => roomName(a[0]).localeCompare(roomName(b[0])));
  }, [devices, roomName]);
  const zoneOf = (key: string) => rooms.find(r => r.key === key)?.zone;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand"><span className="logo" /><div><b>Agentic Digital Twin</b><small>SmartThings · Map View</small></div></div>
        <div className="floor-chip"><span className="live" />{rooms.length ? `${rooms.length} rooms${floorTitle ? ` · ${floorTitle}` : ''}` : 'Loading floor…'}</div>
        <div className="stats">
          <span className="stat"><b>{devices.length}</b> devices</span>
          <span className={`stat ${bad.length ? 'warn' : 'good'}`}><b>{bad.length}</b> {bad.length === 1 ? 'needs' : 'need'} attention</span>
          <button className="ghost" onClick={() => setupRoom()}>Hotel setup</button>
          <a href="/tech"><button className="ghost">Technician</button></a>
          <a href="/setup"><button className="ghost">Upload floor plan</button></a>
        </div>
      </header>
      <section className="stage" ref={stage}>
        <TwinView onEvent={onEvent} ready={ready && floorShown} />
        {walk.on ? <WalkHud room={walk.roomName ?? ''} note={walk.note} rooms={rooms.map(r => ({ key: r.key, name: r.name }))} onQr={walk.room && walk.room !== 'out' ? () => setQrFor({ room: walk.room!, roomName: walk.roomName ?? walk.room! }) : undefined} /> : (
          <>
            <DevicePalette stage={stage} hover={hover} counts={counts} />
            <MapToolbar />
            <MapNav />
          </>
        )}
        {!walk.on && ready && devices.length === 0 && !hintClosed && (
          <div className="empty-hint glass">
            <button className="hint-close" aria-label="Close" title="Close" onClick={closeHint}>✕</button>
            <b>This floor has no SmartThings devices yet</b>
            <span>Drag devices from the palette onto any room. Wall units snap to the nearest wall, locks go beside a door, lights on the ceiling.</span>
          </div>
        )}
        {roomSel && !walk.on && (
          <div className="room-card glass">
            <button className="hint-close" aria-label="Close" onClick={() => { setRoomSel(null); send({ type: 'selectRoom', room: '' }); }}>✕</button>
            <span className="muted">Room</span>
            <b>{roomSel.roomName}</b>
            <span className="muted">{devices.filter(d => d.room === roomSel.room).length} SmartThings devices</span>
            <div className="row">
              <button onClick={() => { send({ type: 'walk', action: 'start', room: roomSel.room }); }}>Walk in</button>
              <button onClick={() => setupRoom(roomSel.room)}>Set up as guest room</button>
              <button className="pri" onClick={() => setQrFor(roomSel)}>Guest QR code</button>
            </div>
          </div>
        )}
        {qrFor && <GuestQr room={qrFor.room} roomName={qrFor.roomName} onClose={() => setQrFor(null)} />}
        {moving && <div className="move-hint glass">Moving <b>{moving}</b>: click where it should go · right-click or Esc to cancel</div>}
        {stale && (
          <div className="stale glass">
            <b>The 3D renderer build is out of date</b> (built {stale}, this page needs {RENDERER_VERSION}). Mouse and touch
            controls may not match. Re-export it: <code>cd web &amp;&amp; npm run export:renderer</code>, then restart the server.
            <button className="hint-close" aria-label="Close" onClick={() => setStale('')}>✕</button>
          </div>
        )}
        <div className="toasts">{toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
      </section>
      <aside className="side">
        {sel ? <DevicePanel id={sel} t={sim ? Math.round(sim.t * 10) / 10 : 10} onClose={() => setSel(null)} onSelect={select} onMove={move} onRemove={remove} /> : (
          <>
            <div className="tabs"><button className={tab === 'devices' ? 'on' : ''} onClick={() => setTab('devices')}>Devices <i>{devices.length}</i></button><button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>AI agent</button></div>
            {tab === 'agent' ? <ChatPanel onSelect={select} /> : (
              <div className="list">
                {devices.length === 0 && <div className="muted pad">Nothing placed yet. Drag a device from the palette on the map.</div>}
                {byRoom.map(([room, rows]) => (
                  <div key={room} className="room-group">
                    <div className="room-title"><span>{roomName(room)}</span>{zoneOf(room) && <em>Zone {zoneOf(room)}</em>}</div>
                    {rows.map(d => (
                      <div key={d.id} className="dev-row" onClick={() => select(d.id)} onMouseEnter={() => send({ type: 'highlight', ids: [d.id] })} onMouseLeave={() => send({ type: 'clearHighlight' })}>
                        <span className="dev-ico"><DeviceIcon type={d.type} size={18} /></span>
                        <span className="dev-txt"><b>{d.id}</b><small>{d.label}{d.fault && <em> · simulated fault</em>}</small></span>
                        <i className={`dot ${d.health}`} />
                      </div>))}
                  </div>))}
              </div>
            )}
          </>
        )}
      </aside>
    </main>
  );
}
