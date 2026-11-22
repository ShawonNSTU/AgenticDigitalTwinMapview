'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { straighten } from '@/lib/homography';
import { useRouter } from 'next/navigation';
import { interior, noWayIn, rect, roomColor, roomKey, toBuilding, type PlanFurniture, type PlanNote, type PlanRoom, type Pt } from '@/lib/layout';
import { furnish } from '@/lib/furnish';

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
  const [furniture, setFurniture] = useState<PlanFurniture[]>([]);   // items read from the plan
  const [doors, setDoors] = useState<PlanFurniture[]>([]);           // kind 'door', on wall lines
  const [suggest, setSuggest] = useState(true);                      // add suggested interiors to rooms without items
  const [scaleNote, setScaleNote] = useState('');
  const [notes, setNotes] = useState<PlanNote[]>([]);
  const [location, setLocation] = useState('');                       // building or site, shown in the map header
  const [floorName, setFloorName] = useState('');                     // e.g. "4th floor"
  const [known, setKnown] = useState<string | null>(null);            // a floor the platform has a checked model of
  const [mode, setMode] = useState<'rooms' | 'doors' | 'straighten'>('rooms');
  const [quad, setQuad] = useState<Pt[]>([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]); // TL TR BR BL, image fractions
  const [qdrag, setQdrag] = useState<number | null>(null);
  const [widthM, setWidthM] = useState(20);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);          // polygon being drawn, click by click
  const [hover, setHover] = useState<Pt | null>(null);
  const [vtx, setVtx] = useState<{ room: number; i: number; at: Pt; moved: boolean } | null>(null); // corner pressed: click adds it, drag moves it
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);                     // the plan's drawing tools are open
  const [hasFloor, setHasFloor] = useState(false);                    // a floor is built already (else this is the first step)
  useEffect(() => { fetch('/api/building').then(r => r.json()).then(b => setHasFloor(!b.empty)).catch(() => {}); }, []);
  const ar = img ? img.h / img.w : 0.6;
  // rooms the plan's doors give no way into (pointed out in the room list)
  const shut = useMemo(() => noWayIn(rooms, doors, ar), [rooms, doors, ar]);
  // suggested interiors depend on the real size, so they follow the plan width
  const suggested = useMemo(() => (suggest ? furnish(rooms, furniture, doors, widthM, ar) : []), [suggest, rooms, furniture, doors, widthM, ar]);

  const pt = (e: React.PointerEvent) => {
    const s = svg.current!; const p = s.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(s.getScreenCTM()!.inverse());
    return { x: q.x, y: q.y / ar }; // fractions of image width / height
  };
  const addRoom = (pts: Pt[]) => setRooms(rs => { const name = `Room ${rs.length + 1}`; return [...rs, { key: roomKey(name, new Set(rs.map(r => r.key))), name, pts, color: roomColor(rs.length) }]; });
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * ar) < 0.012;
  function closeDraft() { if (draft.length >= 3) addRoom(draft); setDraft([]); }

  // Rooms mode: drag = rectangle; click = add a corner (click the first corner, double-click or Enter to close).
  async function straightenImg(src: Img, q: Pt[]): Promise<Img> {
    const im = new Image(); im.src = src.url; await im.decode();
    const c = straighten(im, q.map(([x, y]) => [x * src.w, y * src.h] as [number, number]));
    return { url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
  }
  async function applyStraighten() {
    if (!img) return;
    const flat = await straightenImg(img, quad);
    setImg(flat); setMode('rooms');
    await detect(flat, true);
  }

  function down(e: React.PointerEvent) {
    if (!img || !editing) return;
    const p = pt(e);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (mode === 'straighten') {
      const k = quad.findIndex(q => near([p.x, p.y], q) || Math.hypot(q[0] - p.x, (q[1] - p.y) * ar) < 0.03);
      setQdrag(k >= 0 ? k : null);
      return;
    }
    if (mode === 'rooms') setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y });
    else toggleDoor([p.x, p.y]);
  }
  function move(e: React.PointerEvent) {
    const p = pt(e);
    setHover([p.x, p.y]);
    if (mode === 'straighten') { if (qdrag !== null) setQuad(q => q.map((v, i) => i === qdrag ? [p.x, p.y] as Pt : v)); return; }
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
    if (mode === 'straighten') { setQdrag(null); return; }
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

  /** Doors mode: click a door to remove it, or a wall to add a 0.9 m door there (snapped onto the nearest room edge). */
  function toggleDoor(p: Pt) {
    const hit = doors.findIndex(d => Math.hypot(d.fx - p[0], (d.fy - p[1]) * ar) < Math.max(0.012, d.fw / 2));
    if (hit >= 0) { setDoors(ds => ds.filter((_, i) => i !== hit)); return; }
    let best: { q: Pt; ux: number; uz: number; dist: number } | null = null;
    for (const r of rooms) for (let i = 0; i < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[(i + 1) % r.pts.length];
      const dx = b[0] - a[0], dz = (b[1] - a[1]) * ar, L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * ar * dz) / (L * L)));
      const q: Pt = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const dist = Math.hypot(q[0] - p[0], (q[1] - p[1]) * ar);
      if (!best || dist < best.dist) best = { q, ux: dx / L, uz: dz / L, dist };
    }
    if (!best || best.dist > 0.03) return;
    const fw = 0.9 / widthM;
    setDoors(ds => [...ds, { kind: 'door', fx: best!.q[0], fy: best!.q[1], fw, fd: 0.15 / widthM, rot: -Math.atan2(best!.uz, best!.ux) }]);
  }

  /** Read the plan: rooms, doors, scale, names. A photo at an angle is straightened first (once), then read again.
   *  The reader sends back the drawing cropped to the building with its text removed: that is what the 3D floor shows. */
  async function detect(src = img, straightened = false) {
    if (!src) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/floorplan/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: src.url }) });
      const j = await r.json();
      if (!r.ok) { setMsg('Couldn’t read this plan. Draw the rooms with the Rooms tool.'); return; }
      if (j.photo_corners && !j.known) {
        if (!straightened) {
          // a photo of a sheet taken at an angle: flatten it on the corners the reader found, then read again
          setQuad(j.photo_corners);
          const flat = await straightenImg(src, j.photo_corners);
          setImg(flat);
          setBusy(false);
          return detect(flat, true);
        }
        setQuad(j.photo_corners); setMode('straighten'); setEditing(true);
        setMsg('');
        return;
      }
      let base = src;
      if (j.known) base = j.image ? await loadUrl(j.image) : blank(j.aspect ?? src.h / src.w);
      else if (j.image) base = await loadUrl(j.image);
      setImg(base);
      setKnown(j.known ?? null);
      const taken = new Set<string>();
      setRooms(j.rooms.map((x: { name: string; label?: string; zone?: string; points: Pt[] }, i: number) => { const key = roomKey(x.name, taken); taken.add(key); return { name: x.name, ...(x.label ? { label: x.label } : {}), ...(x.zone ? { zone: x.zone } : {}), pts: x.points, key, color: roomColor(i) }; }));
      setFurniture((j.furniture ?? []) as PlanFurniture[]);
      setDoors((j.doors ?? []) as PlanFurniture[]);
      setNotes([]);
      if (j.width_m) setWidthM(j.width_m);
      if (j.location) setLocation(j.location);
      if (j.floor) setFloorName(j.floor);
      setScaleNote(j.width_m && !j.known ? `Estimated ${j.scale_note ?? ''}.` : '');
      setMode('rooms');
      const named = j.rooms.filter((x: { name: string }) => !/^Room \d+$/.test(x.name)).length;
      setMsg(j.rooms.length ? '' : 'No rooms found. Draw them with the Rooms tool.'); void named;
    } catch { setMsg('Couldn’t read this plan. Draw the rooms with the Rooms tool.'); } finally { setBusy(false); }
  }

  async function build() {
    if (!img || !rooms.length) return;
    setBusy(true); setMsg('');
    const title = [location.trim(), floorName.trim()].filter(Boolean).join(' · ') || 'Uploaded floor plan';
    // a recognised floor is built from its checked model; any other plan from what was read (no devices yet:
    // they are dragged onto the 3D map afterwards)
    const body = known ? { known } : toBuilding(rooms, [], widthM, ar, img.url, [...furniture, ...suggested, ...doors], notes, title);
    const r = await fetch('/api/building', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setBusy(false);
    if (r.ok) router.push('/'); else setMsg((await r.json()).error ?? 'Could not save the layout');
  }

  const loadUrl = (url: string) => new Promise<Img>((res, rej) => { const im = new Image(); im.onload = () => res({ url: toData(im), w: im.width, h: im.height }); im.onerror = rej; im.src = url; });
  const toData = (im: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0); return c.toDataURL('image/jpeg', 0.9); };
  /** Plain paper of a given shape, for a floor whose drawing is not stored here. */
  const blank = (aspect: number): Img => { const c = document.createElement('canvas'); c.width = 1600; c.height = Math.round(1600 * aspect); const g = c.getContext('2d')!; g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, c.width, c.height); return { url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height }; };

  /** A new file: guess the floor from its name, then read it straight away. */
  async function upload(f: File) {
    try {
      const im = await loadImage(f);
      const base = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
      const fl = /\b(ground|basement|mezzanine|roof|\d+(st|nd|rd|th)?)\s*(floor|fl|level)\b|\b(level|floor)\s*\d+\b/i.exec(base)?.[0] ?? '';
      setImg(im); setKnown(null);
      setLocation(base.replace(fl, '').replace(/\s+/g, ' ').trim().slice(0, 50) || 'My building');
      setFloorName(fl ? fl.replace(/\b\w/, c => c.toUpperCase()) : 'Ground floor');
      setRooms([]); setDoors([]); setFurniture([]); setNotes([]); setScaleNote('');
      await detect(im);
    } catch (err) { setMsg((err as Error).message); }
  }
  const rename = (i: number, name: string) => setRooms(rs => rs.map((r, j) => j === i ? { ...r, name } : r));
  const fs = 0.016;

  const tools: { key: typeof mode; label: string; hint: string }[] = [
    { key: 'rooms', label: 'Rooms', hint: 'Drag a rectangle, or click corners to draw any shape' },
    { key: 'doors', label: 'Doors', hint: 'Click a wall to add a door, a door to remove it' },
    { key: 'straighten', label: 'Straighten', hint: 'Drag the four handles onto the plan’s corners' },
  ];
  const tool = tools.find(t => t.key === mode)!;
  const stage = !img ? 'upload' : busy && !rooms.length ? 'reading' : 'review';

  return (
    <main className="setup">
      <header className="topbar">
        <a href="/" className="brand"><span className="logo" /><div><b>Agentic Digital Twin</b><small>New floor</small></div></a>
        <div className="stats">{hasFloor && <a href="/"><button className="ghost">Cancel</button></a>}</div>
      </header>
      <div className={`setup-body ${stage}`}>
        <section className="plan">
          {!img ? (
            <label className="drop">
              <span className="drop-ico" aria-hidden>⬆</span>
              <b>Upload a floor plan</b>
              <span className="muted">An image, a scan or a photo of a printed plan</span>
              <span className="drop-btn">Choose a file</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
            </label>
          ) : (<>
            {stage === 'review' && (
              <div className="plan-tools glass">
                {editing ? <>
                  <div className="seg">{tools.map(t => <button key={t.key} className={mode === t.key ? 'on' : ''} onClick={() => setMode(t.key)}>{t.label}</button>)}</div>
                  {mode === 'straighten' && <button className="pri" onClick={applyStraighten}>Apply</button>}
                  <button className="ghost" onClick={() => { setEditing(false); setMode('rooms'); setDraft([]); }}>Done</button>
                </> : <button onClick={() => setEditing(true)}>Edit plan</button>}
              </div>
            )}
            {stage === 'review' && editing && <div className="plan-hint glass">{tool.hint}</div>}
            {stage === 'reading' && <div className="plan-reading glass"><span className="spinner" />Reading your plan…</div>}
            <svg ref={svg} tabIndex={0} viewBox={`${-PAD} ${-PAD} ${1 + 2 * PAD} ${ar + 2 * PAD}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={closeDraft} onKeyDown={key} className={editing ? mode : 'view'}>
              <rect x={-PAD} y={-PAD} width={1 + 2 * PAD} height={ar + 2 * PAD} fill="#eef2f7" />
              <image href={img.url} x={0} y={0} width={1} height={ar} preserveAspectRatio="none" />
              {editing && furniture.length + suggested.length > 0 && (
                <g pointerEvents="none" opacity={0.7}>
                  {[...furniture, ...suggested].map((f, i) => {
                    // footprint rectangle rotated to its facing direction (rot 0 faces down the image)
                    const w = f.fw, d = f.fd, c = Math.cos(f.rot), s = Math.sin(f.rot);
                    const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([lx, lz]) => `${f.fx + lx * c + lz * s},${f.fy * ar - lx * s + lz * c}`).join(' ');
                    return <polygon key={i} points={pts} fill={f.kind === 'column' ? '#555' : f.suggested ? '#7aa7ff' : '#ffb020'} fillOpacity={0.35} stroke={f.suggested ? '#3d6fd6' : '#b26b00'} strokeWidth={0.0012} strokeDasharray={f.suggested ? '0.003 0.002' : undefined} />;
                  })}
                </g>
              )}
              {rooms.map((r, k) => { const c = interior(r.pts); return (
                <g key={r.key}>
                  <polygon points={r.pts.map(([x, y]) => `${x},${y * ar}`).join(' ')} fill={r.color} fillOpacity={0.35} stroke={r.color} strokeWidth={0.003} />
                  <text x={c[0]} y={c[1] * ar} fontSize={fs} textAnchor="middle" fill="#111">{r.name}</text>
                  {editing && mode === 'rooms' && r.pts.map(([x, y], i) => (
                    <circle key={i} cx={x} cy={y * ar} r={0.006} fill="#fff" stroke={r.color} strokeWidth={0.003} style={{ cursor: 'move' }}
                      onPointerDown={e => { e.stopPropagation(); (e.currentTarget.ownerSVGElement as Element).setPointerCapture?.(e.pointerId); setVtx({ room: k, i, at: [x, y], moved: false }); }} />
                  ))}
                </g>); })}
              {editing && mode === 'straighten' && (
                <g>
                  <polygon points={quad.map(([x, y]) => `${x},${y * ar}`).join(' ')} fill="#4c8dff" fillOpacity={0.08} stroke="#ffb020" strokeWidth={0.003} strokeDasharray="0.01 0.006" />
                  {quad.map(([x, y], i) => (
                    <g key={i}>
                      <circle cx={x} cy={y * ar} r={0.012} fill="#ffb020" fillOpacity={0.35} stroke="#ffb020" strokeWidth={0.003} style={{ cursor: 'move' }} />
                      <circle cx={x} cy={y * ar} r={0.0025} fill="#000" />
                      <text x={x + 0.015} y={y * ar - 0.012} fontSize={fs} fill="#ffb020" stroke="#000" strokeWidth={0.002} paintOrder="stroke">{['top-left', 'top-right', 'bottom-right', 'bottom-left'][i]}</text>
                    </g>
                  ))}
                </g>
              )}
              {draft.length > 0 && (
                <g pointerEvents="none">
                  <polyline points={[...draft, ...(hover ? [hover] : [])].map(([x, y]) => `${x},${y * ar}`).join(' ')} fill="#4c8dff" fillOpacity={0.15} stroke="#4c8dff" strokeWidth={0.003} />
                  {draft.map(([x, y], i) => <circle key={i} cx={x} cy={y * ar} r={i === 0 ? 0.008 : 0.005} fill="#4c8dff" />)}
                </g>
              )}
              {drag && <rect x={Math.min(drag.x, drag.x2)} y={Math.min(drag.y, drag.y2) * ar} width={Math.abs(drag.x2 - drag.x)} height={Math.abs(drag.y2 - drag.y) * ar} fill="#4c8dff" fillOpacity={0.25} stroke="#4c8dff" strokeWidth={0.003} />}
              {doors.map((d, i) => {
                const ux = Math.cos(d.rot), uz = -Math.sin(d.rot), h = d.fw / 2;
                return <line key={i} x1={d.fx - ux * h} y1={d.fy * ar - uz * h} x2={d.fx + ux * h} y2={d.fy * ar + uz * h} stroke="#22c55e" strokeWidth={0.006} strokeLinecap="round" style={{ cursor: mode === 'doors' ? 'pointer' : undefined }} />;
              })}
            </svg>
          </>)}
        </section>
        {img && (
          <aside className="side setup-side">
            <div className="panel">
              {stage === 'reading' ? <div className="setup-wait muted">Finding rooms, doors and names…</div> : <>
                <div className="setup-head">
                  <h3>Check your floor</h3>
                  <span className="muted">{rooms.length} rooms · {doors.length} doors · {widthM} m wide</span>
                </div>
                {msg && <div className="note">{msg}</div>}
                <div className="setup-fields">
                  <label className="field">Building<input value={location} placeholder="Head office" onChange={e => setLocation(e.target.value)} /></label>
                  <label className="field">Floor<input value={floorName} placeholder="4th floor" onChange={e => setFloorName(e.target.value)} /></label>
                  <label className="field" title={scaleNote ? `${scaleNote} Correct it if you know a real dimension.` : ''}>Width (m)<input type="number" min={4} max={400} step={0.5} value={widthM} onChange={e => setWidthM(+e.target.value)} /></label>
                </div>
                <div className="sec-title">Rooms</div>
                {!known && shut.size > 0 && <div className="note">No door found into {shut.size === 1 ? 'one room' : `${shut.size} rooms`}. Add {shut.size === 1 ? 'it' : 'them'} with <b>Doors</b>, or the 3D walk will guess.</div>}
                {rooms.length ? <div className="room-list">{rooms.map((r, i) => (
                  <div key={r.key} className="row"><i className="dot" style={{ background: r.color }} /><input aria-label="Room name" value={r.name} onChange={e => rename(i, e.target.value)} />{!known && shut.has(r.key) && <span className="nodoor" title="No door into this room">no door</span>}<button className="icon" title="Remove room" onClick={() => setRooms(rs => rs.filter((_, j) => j !== i))}>✕</button></div>
                ))}</div> : <div className="muted">None yet. Use <b>Edit plan</b> to draw them.</div>}
                <label className="switch"><input type="checkbox" checked={suggest} onChange={e => setSuggest(e.target.checked)} /><span /> Furnish rooms by type</label>
              </>}
            </div>
            <div className="setup-foot">
              <button className="pri wide" disabled={!rooms.length || busy} onClick={build}>{busy && rooms.length ? 'Creating…' : 'Create 3D map'}</button>
              <div className="row between">
                <button className="ghost small" disabled={busy} onClick={() => detect()}>Read again</button>
                <label className="ghost-file small"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />Another plan</label>
              </div>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
