'use client';
import { useCallback, useEffect, useState } from 'react';
import { send } from '@/lib/bridge';

// The hotel's live operations, beside the 3D floor: energy (now, today, cost, carbon, what the automation saved),
// comfort per room (with "make it comfortable"), guest arrivals (being prepared, ready, in the room, away) and
// housekeeping, and predicted failures with "send a technician" (the 3D view draws the route).

type Energy = {
  w: number; kwh: number; cost: number; co2Kg: number; avoided: { kwh: number; cost: number; co2Kg: number }; tariff: { currency: string; perKWh: number; co2PerKWh: number };
  rooms: { key: string; name: string; w: number; kwh: number; eco: boolean }[]; top: { id: string; name: string; w: number; src: string }[];
  eco: { room: string; name: string; reason: string; kwh: number }[]; trend: { at: number; w: number }[] | null; metered: number; modelled: number;
};
type Comfort = { room: string; name: string; score: number; grade: string; temp: number; target: number; hum: number; pm: number; advice: { text: string }[]; etaToTargetMin: number | null };
type Journey = { token: string; guest: string; room: string; roomName: string; state: string; eta: number | null; readyAt: number | null; steps: { status: string; real?: boolean }[]; prefs: { temp: number; scene: string; curtain: number }; comfort: { temp: number; target: number } | null };
type Housekeeping = { id: string; roomName: string; status: string; at: number; items: string[] };
type Prediction = { key: string; deviceId: string; name: string; roomName: string; title: string; etaText: string; etaMin: number | null; confidence: number; basis: string; evidence: string[]; action: string; partName: string | null; part: string | null };
type Dispatch = { deviceId: string; tech: { name: string } | null; fromName: string; status: string };

const STATE: Record<string, [string, string]> = {
  booked: ['Checked in', 'muted'], en_route: ['On the way', 'acc'], preparing: ['Preparing', 'watch'], ready: ['Ready', 'ok'],
  arrived: ['In the room', 'acc'], away: ['Out · eco', 'muted'], departed: ['Checked out', 'muted'],
};
const fmtW = (w: number) => (w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);
const post = (url: string, body: object, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function Spark({ pts }: { pts: { w: number }[] }) {
  if (pts.length < 2) return <div className="ops-spark muted small">Collecting the trend…</div>;
  const max = Math.max(...pts.map(p => p.w), 1), W = 260, H = 40;
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * W},${H - (p.w / max) * (H - 4) - 2}`).join(' ');
  return <svg className="ops-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Power over the last hours"><polyline points={d} fill="none" stroke="var(--acc)" strokeWidth="1.6" /></svg>;
}

export function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r, col = score >= 85 ? 'var(--ok)' : score >= 70 ? '#65a30d' : score >= 50 ? 'var(--watch)' : 'var(--fault)';
  return (
    <svg width={size} height={size} className="score-ring" aria-label={`Comfort ${score} of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--line)" strokeWidth="4" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth="4" fill="none" strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="54%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.32} fontWeight="600" fill="var(--text)">{score}</text>
    </svg>
  );
}

export default function OpsPanel({ toast }: { toast: (t: string, k?: 'ok' | 'bad') => void }) {
  const [energy, setEnergy] = useState<Energy | null>(null);
  const [comfort, setComfort] = useState<Comfort[]>([]);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [hk, setHk] = useState<Housekeeping[]>([]);
  const [preds, setPreds] = useState<Prediction[]>([]);
  const [disp, setDisp] = useState<Dispatch[]>([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const [e, c, a, p] = await Promise.all(['/api/energy', '/api/comfort', '/api/arrivals', '/api/predictions'].map(u => fetch(u, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)));
    if (e) setEnergy(e);
    if (c) setComfort([...c.rooms].sort((x: Comfort, y: Comfort) => x.score - y.score));
    if (a) { setJourneys(a.journeys); setHk(a.housekeeping); }
    if (p) { setPreds(p.predictions); setDisp(p.dispatches); }
  }, []);
  useEffect(() => { load(); const h = setInterval(load, 3000); return () => clearInterval(h); }, [load]);

  const act = async (key: string, fn: () => Promise<Response>, ok: string) => {
    setBusy(key);
    const r = await fn().catch(() => null);
    setBusy('');
    if (r?.ok) toast(ok); else toast((await r?.json().catch(() => null))?.error ?? 'That didn’t work', 'bad');
    load();
  };

  const T = energy?.tariff;
  return (
    <div className="panel ops">
      {/* energy */}
      <div className="ops-card">
        <div className="ops-head"><b title={energy ? `${energy.metered} metered, ${energy.modelled} estimated from live state · ${T?.perKWh} ${T?.currency}/kWh · ${T?.co2PerKWh} kg CO₂/kWh` : ''}>Energy</b><button className="ghost small" onClick={() => send({ type: 'setLayer', layer: 'energy', on: true })}>Show in 3D</button></div>
        {energy ? <>
          <div className="kpis">
            <div><small>Now</small><b>{fmtW(energy.w)}</b></div>
            <div><small>Today</small><b>{energy.kwh.toFixed(2)} kWh</b></div>
            <div><small>Cost</small><b>{energy.cost.toFixed(2)} {T?.currency}</b></div>
            <div><small>CO₂</small><b>{energy.co2Kg.toFixed(2)} kg</b></div>
          </div>
          <div className="saved"><span>Saved by eco mode today</span><b>{energy.avoided.kwh.toFixed(3)} kWh · {energy.avoided.cost.toFixed(2)} {T?.currency} · {energy.avoided.co2Kg.toFixed(2)} kg CO₂</b></div>
          <Spark pts={energy.trend ?? []} />
          {energy.eco.length > 0 && <div className="small">{energy.eco.map(x => <div key={x.room} className="eco-row"><span className="eco-tag">ECO</span>{x.name} · {x.reason} · {x.kwh.toFixed(3)} kWh avoided</div>)}</div>}
          <div className="ops-rows">{energy.top.slice(0, 5).map(t => (
            <div key={t.id} className="ops-row" onMouseEnter={() => send({ type: 'highlight', ids: [t.id] })} onMouseLeave={() => send({ type: 'clearHighlight' })} onClick={() => send({ type: 'focusDevice', id: t.id })}>
              <span className="grow">{t.name} <em className="muted">{t.id}</em></span><b>{fmtW(t.w)}</b>{t.src === 'meter' && <em className="meter">metered</em>}
            </div>))}</div>
        </> : <div className="muted">Loading…</div>}
      </div>

      {/* arrivals */}
      <div className="ops-card">
        <div className="ops-head"><b>Guests</b><span className="muted small">{journeys.filter(j => j.state !== 'departed').length || 'none'}</span></div>
        {journeys.map(j => {
          const [label, tone] = STATE[j.state] ?? [j.state, 'muted'];
          const eta = j.eta ? Math.max(0, Math.round((j.eta - Date.now()) / 60000)) : null;
          const done = j.steps.filter(s => s.status === 'done').length;
          return (
            <div key={j.token} className="journey-row" onClick={() => send({ type: 'selectRoom', room: j.room })}>
              <div className="row between"><b>{j.guest || 'Guest'}</b><span className={`state-chip ${tone}`}>{label}{eta != null && ['en_route', 'preparing'].includes(j.state) ? ` · ${eta} min` : ''}</span></div>
              <div className="muted small">{j.roomName}{j.comfort ? ` · ${j.comfort.temp} °C → ${j.prefs.temp} °C` : ''}{j.steps.length ? ` · welcome ${done}/${j.steps.length}${j.steps.some(s => s.real) ? ` (${j.steps.filter(s => s.real).length} real SmartThings)` : ''}` : ''}</div>
              {j.state !== 'departed' && <div className="row" onClick={e => e.stopPropagation()}>
                {['booked', 'away'].includes(j.state) && <button className="small" disabled={busy === j.token} onClick={() => act(j.token, () => post('/api/arrivals', { action: 'eta', token: j.token, minutes: 10 }), `${j.guest || 'Guest'} expected in 10 min`)}>Arriving in 10 min</button>}
                {!['preparing', 'ready', 'arrived'].includes(j.state) && <button className="small pri" disabled={busy === j.token} onClick={() => act(j.token, () => post('/api/arrivals', { action: 'prepare', token: j.token }), `Preparing ${j.roomName}`)}>Prepare now</button>}
                <button className="small ghost" disabled={busy === j.token} onClick={() => { if (confirm(`Check ${j.guest || 'this guest'} out? The room goes to eco and housekeeping is requested.`)) act(j.token, () => post('/api/arrivals', { action: 'checkout', token: j.token }), 'Checked out · housekeeping requested'); }}>Check out</button>
              </div>}
            </div>);
        })}
        {hk.length > 0 && <><div className="sec-title">Housekeeping</div>{hk.slice(0, 4).map(h => (
          <div key={h.id} className="ops-row"><span className="grow">{h.roomName} <em className="muted">{h.items.slice(0, 2).join(', ')}…</em></span>
            <select aria-label="Housekeeping status" value={h.status} onChange={e => act(h.id, () => post('/api/arrivals', { action: 'housekeeping', id: h.id, status: e.target.value }), 'Housekeeping updated')}>
              <option value="requested">Requested</option><option value="in_progress">In progress</option><option value="done">Done</option>
            </select></div>))}</>}
      </div>

      {/* comfort */}
      <div className="ops-card">
        <div className="ops-head"><b>Comfort</b><button className="ghost small" onClick={() => send({ type: 'setLayer', layer: 'comfort', on: true })}>Show in 3D</button></div>
        {comfort.slice(0, 6).map(c => (
          <div key={c.room} className="comfort-row" onClick={() => send({ type: 'selectRoom', room: c.room })}>
            <ScoreRing score={c.score} size={38} />
            <span className="grow"><b>{c.name}</b><small className="muted">{c.temp} °C · {c.hum} % humidity</small></span>
            {c.advice.length > 0 && <button className="small" disabled={busy === c.room} onClick={e => { e.stopPropagation(); act(c.room, () => post('/api/comfort', { room: c.room }), `${c.name}: comfort settings applied`); }}>Fix</button>}
          </div>))}
      </div>

      {/* predictions */}
      <div className="ops-card">
        <div className="ops-head"><b>Predicted failures</b><span className="muted small">{preds.length || 'none'}</span></div>
        {preds.slice(0, 5).map(p => {
          const d = disp.find(x => x.deviceId === p.deviceId && x.status !== 'done');
          return (
            <div key={p.key} className="pred-row" onMouseEnter={() => send({ type: 'highlight', ids: [p.deviceId] })} onMouseLeave={() => send({ type: 'clearHighlight' })}>
              <div className="row between"><b>{p.name} <em className="muted">{p.deviceId}</em></b><span className="eta-chip">{p.etaMin != null ? `in ${p.etaText}` : p.etaText}</span></div>
              <div className="small">{p.title}</div>
              <div className="muted tiny">{p.roomName} · {Math.round(p.confidence * 100)} % sure</div>
              <div className="row">
                {d ? <span className="muted small">{d.tech?.name ?? 'Technician'} {d.status === 'on_site' ? 'on site' : `on the way from ${d.fromName}`}</span>
                  : <button className="small pri" disabled={busy === p.key} onClick={() => act(p.key, async () => { const r = await post('/api/predictions', { deviceId: p.deviceId, reason: p.title }); if (r.ok) send({ type: 'dispatchRoute', id: p.deviceId }); return r; }, 'Technician dispatched · route on the map')}>Send a technician</button>}
                <button className="small ghost" onClick={() => send({ type: 'openDevice', id: p.deviceId, ...(p.part ? { part: p.part } : {}) })}>X-ray</button>
              </div>
            </div>);
        })}
      </div>
    </div>
  );
}
