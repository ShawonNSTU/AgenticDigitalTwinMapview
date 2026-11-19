'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEVICE_TYPES, PREFIX, autoPlace, interior, nextId, rect, roomAt, roomColor, roomKey, toBuilding, type PlanDevice, type PlanRoom, type Pt } from '@/lib/layout';

type Img = { url: string; w: number; h: number };
const PAD = 0.08;

/** Downscale to at most 2000 px so the upload and the Godot texture stay small. */
function loadImage(file: File): Promise<Img> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const im = new Image();
      im.onerror = () => reject(new Error('Not an image'));
      im.onload = () => {
        const s = Math.min(1, 2000 / Math.max(im.width, im.height));
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
        const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
        resolve({ url: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height });
      };
      im.src = r.result as string;
    };
    r.readAsDataURL(file);
  });
}

export default function PlanEditor() {
  const router = useRouter();
  const svg = useRef<SVGSVGElement>(null);
  const [img, setImg] = useState<Img | null>(null);
  const [rooms, setRooms] = useState<PlanRoom[]>([]);
  const [devices, setDevices] = useState<PlanDevice[]>([]);
  const [outdoor, setOutdoor] = useState<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<'rooms' | 'devices'>('rooms');
  const [type, setType] = useState('ac');
  const [widthM, setWidthM] = useState(20);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);          // polygon being drawn, click by click
  const [hover, setHover] = useState<Pt | null>(null);
  const [vtx, setVtx] = useState<{ room: number; i: number; at: Pt; moved: boolean } | null>(null); // corner pressed: click adds it, drag moves it
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const ar = img ? img.h / img.w : 0.6;

  const pt = (e: React.PointerEvent) => {
    const s = svg.current!; const p = s.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(s.getScreenCTM()!.inverse());
    return { x: q.x, y: q.y / ar }; // fractions of image width / height
  };
  const addRoom = (pts: Pt[]) => setRooms(rs => { const name = `Room ${rs.length + 1}`; return [...rs, { key: roomKey(name, new Set(rs.map(r => r.key))), name, pts, color: roomColor(rs.length) }]; });
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * ar) < 0.012;
  function closeDraft() { if (draft.length >= 3) addRoom(draft); setDraft([]); }

  // Rooms mode: drag = rectangle; click = add a corner (click the first corner, double-click or Enter to close).
  function down(e: React.PointerEvent) {
    if (!img) return;
    const p = pt(e);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (mode === 'rooms') setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y });
    else setDevices(ds => [...ds, { id: nextId(type, ds), type, fx: p.x, fy: p.y }]);
  }
  function move(e: React.PointerEvent) {
    const p = pt(e);
    setHover([p.x, p.y]);
    if (vtx) {
      const moved = vtx.moved || Math.hypot(p.x - vtx.at[0], (p.y - vtx.at[1]) * ar) > 0.006;
      if (moved) {
        // Move this corner in every room that shares it, so shared walls stay joined.
        const [ox, oy] = vtx.at;
        setRooms(rs => rs.map(r => ({ ...r, pts: r.pts.map(q => Math.abs(q[0] - ox) < 1e-6 && Math.abs(q[1] - oy) < 1e-6 ? [p.x, p.y] as Pt : q) })));
        setVtx({ ...vtx, at: [p.x, p.y], moved: true });
      }
    }
    else if (drag) setDrag({ ...drag, x2: p.x, y2: p.y });
  }
  /** Snap to an existing corner within a few pixels, so neighbouring rooms share exact wall lines. */
  const snap = (p: Pt): Pt => {
    for (const r of rooms) for (const q of r.pts) if (near(p, q)) return q;
    return p;
  };
  function addCorner(p: Pt) {
    if (draft.length >= 3 && near(p, draft[0])) closeDraft();
    else setDraft(ds => [...ds, snap(p)]);
  }
  function up() {
    if (vtx) { const v = vtx; setVtx(null); if (!v.moved) addCorner(v.at); return; }
    if (!drag) return;
    const d = drag; setDrag(null);
    const moved = Math.hypot(d.x2 - d.x, (d.y2 - d.y) * ar) > 0.015;
    if (moved && !draft.length) {
      const [x0, x1] = [d.x, d.x2].sort((a, b) => a - b), [y0, y1] = [d.y, d.y2].sort((a, b) => a - b);
      if (x1 - x0 > 0.02 && y1 - y0 > 0.02) addRoom(rect(x0, y0, x1, y1));
      return;
    }
    addCorner([d.x, d.y]);
  }
  function key(e: React.KeyboardEvent) {
    if (e.key === 'Enter') closeDraft();
    else if (e.key === 'Escape') setDraft([]);
    else if (e.key === 'Backspace') setDraft(ds => ds.slice(0, -1));
  }

  async function detect() {
    if (!img) return;
    setBusy(true); setMsg('Detecting rooms…');
    try {
      const r = await fetch('/api/floorplan/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: img.url }) });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error ?? j.detail ?? 'Room detection failed'); return; }
      const taken = new Set<string>();
      setRooms(j.rooms.map((x: { name: string; points: Pt[] }, i: number) => { const key = roomKey(x.name, taken); taken.add(key); return { name: x.name, pts: x.points, key, color: roomColor(i) }; }));
      setOutdoor(j.outdoor);
      setMsg(`Found ${j.rooms.length} rooms. Check them, rename or redraw any that are off.`);
    } catch { setMsg('Room detection failed. Draw the rooms by hand.'); } finally { setBusy(false); }
  }

  async function build() {
    if (!img || !rooms.length) return;
    setBusy(true); setMsg('Building the 3D map…');
    const body = toBuilding(rooms, devices, widthM, ar, img.url);
    const r = await fetch('/api/building', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setBusy(false);
    if (r.ok) router.push('/'); else setMsg((await r.json()).error ?? 'Could not save the layout');
  }
  async function sample() { await fetch('/api/building', { method: 'DELETE' }); router.push('/'); }
  const rename = (i: number, name: string) => setRooms(rs => rs.map((r, j) => j === i ? { ...r, name } : r));
  const fs = 0.016;

  return (
    <main className="setup">
      <header className="row between">
        <b>Floor plan → 3D map</b>
        <span className="row"><button onClick={sample}>Use the sample home</button><a href="/"><button>Back to map</button></a></span>
      </header>
      <div className="setup-body">
        <section className="plan">
          {!img ? (
            <label className="drop">
              <b>1. Upload a floor plan image</b><span className="muted">PNG, JPEG or WebP. A clean architectural plan works best.</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={async e => { const f = e.target.files?.[0]; if (f) { try { setImg(await loadImage(f)); setRooms([]); setDevices([]); setMsg('Detect rooms with AI, or draw each room on the plan (any shape).'); } catch (err) { setMsg((err as Error).message); } } }} />
            </label>
          ) : (
            <svg ref={svg} tabIndex={0} viewBox={`${-PAD} ${-PAD} ${1 + 2 * PAD} ${ar + 2 * PAD}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={closeDraft} onKeyDown={key} className={mode}>
              <rect x={-PAD} y={-PAD} width={1 + 2 * PAD} height={ar + 2 * PAD} fill="#1a2028" />
              <image href={img.url} x={0} y={0} width={1} height={ar} preserveAspectRatio="none" />
              {rooms.map((r, k) => { const c = interior(r.pts); return (
                <g key={r.key}>
                  <polygon points={r.pts.map(([x, y]) => `${x},${y * ar}`).join(' ')} fill={r.color} fillOpacity={0.35} stroke={r.color} strokeWidth={0.003} />
                  <text x={c[0]} y={c[1] * ar} fontSize={fs} textAnchor="middle" fill="#111">{r.name}</text>
                  {mode === 'rooms' && r.pts.map(([x, y], i) => (
                    <circle key={i} cx={x} cy={y * ar} r={0.006} fill="#fff" stroke={r.color} strokeWidth={0.003} style={{ cursor: 'move' }}
                      onPointerDown={e => { e.stopPropagation(); (e.currentTarget.ownerSVGElement as Element).setPointerCapture?.(e.pointerId); setVtx({ room: k, i, at: [x, y], moved: false }); }} />
                  ))}
                </g>); })}
              {draft.length > 0 && (
                <g pointerEvents="none">
                  <polyline points={[...draft, ...(hover ? [hover] : [])].map(([x, y]) => `${x},${y * ar}`).join(' ')} fill="#4c8dff" fillOpacity={0.15} stroke="#4c8dff" strokeWidth={0.003} />
                  {draft.map(([x, y], i) => <circle key={i} cx={x} cy={y * ar} r={i === 0 ? 0.008 : 0.005} fill="#4c8dff" />)}
                </g>
              )}
              {drag && <rect x={Math.min(drag.x, drag.x2)} y={Math.min(drag.y, drag.y2) * ar} width={Math.abs(drag.x2 - drag.x)} height={Math.abs(drag.y2 - drag.y) * ar} fill="#4c8dff" fillOpacity={0.25} stroke="#4c8dff" strokeWidth={0.003} />}
              {devices.map(d => (
                <g key={d.id} onPointerDown={e => { if (mode === 'devices' && e.shiftKey) { e.stopPropagation(); setDevices(ds => ds.filter(x => x.id !== d.id)); } }}>
                  <circle cx={d.fx} cy={d.fy * ar} r={0.009} fill={d.type === 'odu' ? '#ff8a3d' : '#4c8dff'} stroke="#fff" strokeWidth={0.002} />
                  <text x={d.fx + 0.012} y={d.fy * ar + 0.005} fontSize={fs * 0.75} fill="#fff" stroke="#000" strokeWidth={0.002} paintOrder="stroke">{d.id}</text>
                </g>
              ))}
            </svg>
          )}
        </section>
        <aside className="side setup-side">
          <div className="panel">
            {msg && <div className="muted">{msg}</div>}
            <b>2. Rooms</b>
            <div className="row"><button className="pri" disabled={!img || busy} onClick={detect}>Detect rooms with AI</button><button disabled={!img} className={mode === 'rooms' ? 'on' : ''} onClick={() => setMode('rooms')}>Draw rooms</button></div>
            {mode === 'rooms' && img && <div className="muted">Drag for a rectangle. For any other shape click each corner, then click the first corner (or double-click, or Enter). Click an existing corner to reuse it; drag a white dot to move it (rooms sharing it move too). Backspace undoes a corner, Esc cancels.</div>}
            {rooms.map((r, i) => (
              <div key={r.key} className="row"><i className="dot" style={{ background: r.color }} /><input value={r.name} onChange={e => rename(i, e.target.value)} /><button onClick={() => setRooms(rs => rs.filter((_, j) => j !== i))}>✕</button></div>
            ))}
            <b>3. SmartThings devices</b>
            <div className="row"><button disabled={!rooms.length} onClick={() => { setDevices(ds => autoPlace(rooms, ds, outdoor)); setMode('devices'); }}>Auto-place typical devices</button><button disabled={!img} className={mode === 'devices' ? 'on' : ''} onClick={() => setMode('devices')}>Place by hand</button></div>
            {mode === 'devices' && <div className="row"><select value={type} onChange={e => setType(e.target.value)}>{DEVICE_TYPES.map(t => <option key={t.key} value={t.key}>{t.label} ({PREFIX[t.key]})</option>)}</select><span className="muted">click to place · shift-click to remove</span></div>}
            <div className="muted">{devices.length} devices{devices.length ? `: ${devices.map(d => d.id).join(', ')}` : ''}</div>
            {devices.length > 0 && <button onClick={() => setDevices([])}>Remove all devices</button>}
            <b>4. Build</b>
            <label className="row">Plan width <input type="number" min={4} max={200} step={0.5} value={widthM} onChange={e => setWidthM(+e.target.value)} style={{ width: 80 }} /> m</label>
            <button className="pri" disabled={!img || !rooms.length || busy} onClick={build}>Render the 3D map</button>
            {rooms.some(r => !devices.some(d => roomAt([r], d.fx, d.fy))) && devices.length > 0 && <div className="muted">Some rooms have no devices yet.</div>}
          </div>
        </aside>
      </div>
    </main>
  );
}
