'use client';
import { useEffect, useRef, useState } from 'react';
import { onRenderer, send } from '@/lib/bridge';

type Fix = { x: number; z: number; accuracy: number; source: string; at: number; checkpoint?: string };
/** Walking time at 1.2 m/s, rounded the way people say it. */
const eta = (m: number) => { const t = m / 1.2; return t < 60 ? `${Math.max(5, Math.round(t / 5) * 5)} s` : `${Math.round(t / 60)} min`; };
const SRC: Record<string, string> = { rtls: 'positioning badge', 'rtls-sim': 'badge (simulated)', checkpoint: 'location code', pdr: 'step tracking' };

/** "Find me": live indoor position for the guest. Fixes come from the hotel's positioning badge (RTLS), from
 *  location QR codes on the walls (scanned with this page or the phone camera), and between fixes from the
 *  phone's own step counting and compass (pedestrian dead reckoning). The 3D view follows the position. */
export default function Locator({ token, route, roomName, onUnlock }: { token: string; route: [number, number][]; roomName?: string; onUnlock?: () => void }) {
  const [live, setLive] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [pdr, setPdr] = useState(false);
  const [steps, setSteps] = useState(0);
  const [sim, setSim] = useState(false);
  const [note, setNote] = useState('');
  const [scan, setScan] = useState(false);
  const cfg = useRef({ northDeg: 0, stepLength: 0.7 });
  const pos = useRef<{ x: number; z: number; acc: number } | null>(null);
  const heading = useRef<number | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  // where the 3D map put the position after matching it to the walkable floor, and the way left to the room
  const [where, setWhere] = useState<{ room: string; toRoom?: number; atDoor?: boolean } | null>(null);
  useEffect(() => onRenderer(m => {
    if (m.type !== 'walk' || !m.live) return;
    setWhere({ room: m.live.room, toRoom: m.live.toRoom, atDoor: m.live.atDoor });
    // step tracking carries on from the matched spot, so it never drifts through a wall
    if (pos.current) pos.current = { ...pos.current, x: m.live.x, z: m.live.z };
  }), []);
  useEffect(() => { if (!live) setWhere(null); }, [live]);

  // the latest fix from the server (any source), every second while live
  useEffect(() => {
    if (!live) return;
    const tick = () => fetch(`/api/guest/${token}/position`).then(r => r.json()).then(d => {
      cfg.current = { northDeg: d.northDeg ?? 0, stepLength: d.stepLength ?? 0.7 };
      setFix(d.fix);
      if (d.fix && (d.fix.source !== 'pdr' || !pos.current)) pos.current = { x: d.fix.x, z: d.fix.z, acc: d.fix.accuracy };
    }).catch(() => {});
    tick(); const h = setInterval(tick, 1000); return () => clearInterval(h);
  }, [live, token]);
  useEffect(() => { send({ type: 'walk', action: 'live', on: live }); }, [live]);

  const post = (b: object) => fetch(`/api/guest/${token}/position`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const checkpoint = async (id: string) => {
    const d = await post({ checkpoint: id });
    if (d.error) { setNote(d.error); return; }
    setLive(true); setNote(`Found you: ${d.label}`); pos.current = { x: d.fix.x, z: d.fix.z, acc: 1 };
  };
  // a location code from the URL (scanned with the phone camera → /here/<id> → back here with ?cp=)
  useEffect(() => {
    const cp = new URLSearchParams(window.location.search).get('cp');
    if (cp) { checkpoint(cp); window.history.replaceState(null, '', window.location.pathname); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // step tracking: a step is a peak in the acceleration, the direction is the compass heading turned to the plan
  const startPdr = async () => {
    try {
      const DM = (window as any).DeviceMotionEvent, DO = (window as any).DeviceOrientationEvent;
      if (DM?.requestPermission) { if ((await DM.requestPermission()) !== 'granted') throw new Error('motion'); }
      if (DO?.requestPermission) { if ((await DO.requestPermission()) !== 'granted') throw new Error('orientation'); }
    } catch { setNote('Motion sensors were not allowed.'); return; }
    if (!('DeviceMotionEvent' in window)) { setNote('This device has no motion sensors.'); return; }
    if (!pos.current) setNote('Scan a location code (or use the badge) once, so step tracking knows where you start.');
    setPdr(true); setLive(true);
  };
  useEffect(() => {
    if (!pdr) return;
    let smooth = 9.81, last = 0, up = false, n = 0, lastPost = 0;
    const onOri = (e: any) => {
      const h = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null;
      if (h != null) heading.current = h;
    };
    const onMot = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
      // light smoothing, then a step at each rise above 10.8 m/s² (at most ~3 steps a second), re-armed below 10.2
      const m = Math.hypot(a.x!, a.y!, a.z!); smooth = smooth * 0.55 + m * 0.45;
      const now = performance.now();
      if (!up && smooth > 10.8 && now - last > 300) { up = true; last = now; step(); }
      if (up && smooth < 10.2) up = false;
    };
    const step = () => {
      n += 1; setSteps(n);
      if (!pos.current || heading.current == null) return;
      // heading relative to the plan's "up" (the -z direction), clockwise
      const h = ((heading.current - cfg.current.northDeg) * Math.PI) / 180, L = cfg.current.stepLength;
      pos.current = { x: pos.current.x + Math.sin(h) * L, z: pos.current.z - Math.cos(h) * L, acc: Math.min(15, pos.current.acc + 0.12) };
      const now = Date.now();
      if (now - lastPost > 900) { lastPost = now; post({ x: pos.current.x, z: pos.current.z, accuracy: pos.current.acc, heading: heading.current, source: 'pdr' }); }
    };
    // standing still: re-send the estimate every 10 s so the position stays current
    const keep = setInterval(() => { if (pos.current) post({ x: pos.current.x, z: pos.current.z, accuracy: pos.current.acc, source: 'pdr' }); }, 10_000);
    window.addEventListener('deviceorientationabsolute', onOri as any);
    window.addEventListener('deviceorientation', onOri as any);
    window.addEventListener('devicemotion', onMot);
    return () => { clearInterval(keep); window.removeEventListener('deviceorientationabsolute', onOri as any); window.removeEventListener('deviceorientation', onOri as any); window.removeEventListener('devicemotion', onMot); };
  }, [pdr]); // eslint-disable-line react-hooks/exhaustive-deps

  // demo without a positioning system: a badge walks the planned route at 1.2 m/s with ±0.4 m noise, posting
  // fixes the way an RTLS would
  useEffect(() => {
    if (!sim || route.length < 2) return;
    let i = 0, t = 0, alive = true;
    const pts = route;
    const tick = () => {
      if (!alive) return;
      const a = pts[i], b = pts[i + 1];
      if (!b) { setSim(false); setNote('The simulated badge reached the room.'); return; }
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 0.01;
      t += 1.2 / L;
      if (t >= 1) { i += 1; t = 0; }
      const p = !pts[i + 1] ? pts[i] : [a[0] + (b[0] - a[0]) * Math.min(t, 1), a[1] + (b[1] - a[1]) * Math.min(t, 1)];
      const nx = (Math.random() - 0.5) * 0.7, nz = (Math.random() - 0.5) * 0.7;   // a UWB badge is good to about ±0.3 m
      post({ x: p[0] + nx, z: p[1] + nz, accuracy: 0.6, source: 'rtls-sim' });
      setTimeout(tick, 1000);
    };
    setLive(true); tick();
    return () => { alive = false; };
  }, [sim]); // eslint-disable-line react-hooks/exhaustive-deps

  // scan a location code with this page (where the browser can read QR codes)
  useEffect(() => {
    if (!scan) return;
    const BD = (window as any).BarcodeDetector;
    if (!BD) { setNote('Scan the code with your phone camera instead: it opens this page with your position.'); setScan(false); return; }
    let stream: MediaStream | null = null, alive = true;
    const det = new BD({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(s => {
      stream = s; if (video.current) { video.current.srcObject = s; video.current.play(); }
      const loop = async () => {
        if (!alive || !video.current) return;
        const codes = await det.detect(video.current).catch(() => []);
        const hit = codes.map((c: any) => /\/here\/([\w-]+)/.exec(c.rawValue)?.[1]).find(Boolean);
        if (hit) { setScan(false); checkpoint(hit); return; }
        setTimeout(loop, 300);
      };
      loop();
    }).catch(() => { setNote('The camera is not available.'); setScan(false); });
    return () => { alive = false; stream?.getTracks().forEach(t => t.stop()); };
  }, [scan]); // eslint-disable-line react-hooks/exhaustive-deps

  const age = fix ? Math.round((Date.now() - fix.at) / 1000) : null;
  return (
    <div className="locator glass">
      <div className="row between"><b>Find me</b><label className="switch-line"><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Follow my position</label></div>
      <span className="muted">{fix ? `±${Math.round(fix.accuracy)} m · ${SRC[fix.source] ?? fix.source}${fix.checkpoint ? ` (${fix.checkpoint})` : ''} · ${age}s ago` : live ? 'Waiting for a position: use your badge, scan a location code or start step tracking.' : 'Your position is shared only with this page.'}</span>
      <div className="row wrap">
        <button onClick={() => setScan(true)}>Scan a location code</button>
        <button className={pdr ? 'on' : ''} onClick={startPdr} disabled={pdr}>{pdr ? `Step tracking · ${steps} steps` : 'Step tracking'}</button>
        <button className={sim ? 'on' : ''} disabled={route.length < 2} onClick={() => setSim(!sim)} title="For a demo without a positioning system">{sim ? 'Stop simulated badge' : 'Simulate a badge'}</button>
      </div>
      {live && where && (
        <div className="loc-way">
          {where.toRoom === 0
            ? <span><b>In {roomName ?? 'your room'}</b></span>
            : where.toRoom != null
              ? <span><b>{Math.max(1, Math.round(where.toRoom))} m to {roomName ?? 'your room'}</b> · about {eta(where.toRoom)} walk · now in {where.room}</span>
              : <span>Now in {where.room}</span>}
          {where.atDoor && onUnlock && <button className="pri" onClick={onUnlock}>You’re at your door · Unlock</button>}
        </div>
      )}
      {scan && <video ref={video} className="scan-video" muted playsInline />}
      {note && <span className="loc-note">{note}</span>}
    </div>
  );
}
