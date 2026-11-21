'use client';
import { useCallback, useEffect, useState } from 'react';
import { ScoreRing } from './OpsPanel';
import { send } from '@/lib/bridge';

// "The room knows you're coming": the guest's side of the arrival journey. They say they're on their way (or the
// 3D walk / the hotel's positioning tells), the room is prepared in time for them to their preferences (the zone's
// real SmartThings lights and shade move too), and they see it happen: the steps, the temperature closing in on
// theirs, and the comfort and energy of their room once they're in. Heading out sets eco; coming back prepares again.

type Step = { label: string; status: string; real?: boolean; via?: string; detail?: string };
type J = {
  state: string; roomName: string; guest: string; eta: number | null; etaSource: string | null; distanceM: number | null; leadMin: number | null;
  prefs: { temp: number; scene: 'warm' | 'bright' | 'calm' | 'off'; curtain: number; tvWelcome: boolean }; steps: Step[];
  timeline: { at: number; state: string; text: string }[]; readyAt: number | null; arrivedAt: number | null;
  comfort: { temp: number; target: number; score: number; grade: string; etaToTargetMin: number | null; hum: number } | null;
};
type C = { score: number; grade: string; temp: number; target: number; hum: number; pm: number; lux: number; db: number; parts: Record<string, { score: number; label: string; measured: boolean }>; advice: { text: string }[] };
type E = { w: number; kwh: number; avoided: { kwh: number }; tariff: { currency: string }; cost: number; empty?: boolean };

const FLOW = [['booked', 'Checked in'], ['en_route', 'On the way'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['arrived', 'Welcome']] as const;
const SCENES: [J['prefs']['scene'], string][] = [['warm', 'Warm'], ['bright', 'Bright'], ['calm', 'Calm'], ['off', 'Lights off']];

export default function GuestJourney({ token, onMsg }: { token: string; onMsg: (t: string, bad?: boolean) => void }) {
  const [j, setJ] = useState<J | null>(null);
  const [c, setC] = useState<C | null>(null);
  const [e, setE] = useState<E | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch(`/api/guest/${token}/journey`, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    setJ(d.journey); setC(d.comfort); setE(d.energy);
  }, [token]);
  useEffect(() => { load(); const h = setInterval(load, 2000); return () => clearInterval(h); }, [load]);

  const act = async (body: object, ok?: string) => {
    setBusy(true);
    const r = await fetch(`/api/guest/${token}/journey`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { onMsg(d.error ?? 'That didn’t work', true); return; }
    setJ(d.journey); setC(d.comfort);
    if (ok) onMsg(ok);
    send({ type: 'refreshDevices' });
  };

  if (!j) return <div className="muted pad">Loading your stay…</div>;
  const idx = j.state === 'away' ? 1 : j.state === 'departed' ? 5 : FLOW.findIndex(f => f[0] === j.state);
  const eta = j.eta ? Math.max(0, Math.round((j.eta - Date.now()) / 60000)) : null;
  const done = j.steps.filter(s => s.status === 'done').length;
  const gap = j.comfort ? Math.abs(j.comfort.temp - j.prefs.temp) : 0;
  const head = {
    booked: 'Tell us when you’re on your way and your room will be ready when you arrive.',
    en_route: eta != null ? `See you in about ${eta} min. We start preparing your room ${j.leadMin ?? 5} min before you arrive.` : 'On your way.',
    preparing: `Preparing your room: ${done} of ${j.steps.length} done${j.comfort ? ` · ${j.comfort.temp} °C → ${j.prefs.temp} °C` : ''}${j.comfort?.etaToTargetMin ? `, about ${j.comfort.etaToTargetMin} min` : ''}.`,
    ready: `Your room is ready${j.comfort ? ` at ${j.comfort.temp} °C` : ''}.`,
    arrived: 'Welcome. Your room is set the way you like it.',
    away: 'Enjoy your time out. Your room is in eco and will be ready again when you’re on your way back.',
    departed: 'You have checked out. Thank you for staying with us.',
  }[j.state] ?? '';

  return (
    <div className="journey">
      <div className="stepper">{FLOW.map(([k, l], i) => <div key={k} className={`step-i ${i < idx ? 'done' : i === idx ? 'on' : ''}`}><i /><span>{l}</span></div>)}</div>
      <p className="journey-head">{head}</p>

      {j.state !== 'departed' && (
        <div className="row wrap">
          {['booked', 'away'].includes(j.state) && <>
            <span className="muted small">I’ll be there in</span>
            {[5, 15, 30].map(m => <button key={m} className="small" disabled={busy} onClick={() => act({ action: 'on_my_way', minutes: m }, `Thanks, your room will be ready in ${m} min`)}>{m} min</button>)}
          </>}
          {['booked', 'en_route', 'away'].includes(j.state) && <button className="small pri" disabled={busy} onClick={() => act({ action: 'prepare' }, 'Preparing your room now')}>Prepare now</button>}
          {j.state === 'arrived' && <button className="small" disabled={busy} onClick={() => act({ action: 'away' }, 'Room set to eco while you’re out')}>I’m heading out</button>}
          {['ready', 'arrived'].includes(j.state) && c && c.advice.length > 0 && <button className="small pri" disabled={busy} onClick={() => act({ action: 'comfort' }, 'Adjusting your room')}>Make it comfortable</button>}
        </div>
      )}

      {j.comfort && j.state !== 'departed' && (
        <div className="journey-comfort" onClick={() => send({ type: 'setLayer', layer: 'comfort', on: true })} title="Show the comfort field in 3D">
          <ScoreRing score={j.comfort.score} size={52} />
          <div className="grow">
            <b>{j.comfort.temp} °C</b> <span className="muted">· you like {j.prefs.temp} °C · {j.comfort.hum} % humidity</span>
            <div className="temp-bar"><span style={{ width: `${Math.max(4, 100 - Math.min(100, gap * 30))}%` }} /></div>
            {c && <div className="muted tiny">Air {c.parts.air.label.toLowerCase()} · light {c.parts.light.label.toLowerCase()} · {c.parts.sound.label.toLowerCase()}</div>}
          </div>
        </div>
      )}

      {j.steps.length > 0 && (
        <details className="welcome-steps" open={j.state === 'preparing'}>
          <summary>Welcome scene · {done}/{j.steps.length}{j.steps.some(s => s.real) ? ` · ${j.steps.filter(s => s.real).length} on real SmartThings devices` : ''}</summary>
          <ul>{j.steps.map((s, i) => <li key={i} className={s.status}><i />{s.label}{s.real && <em className="st-tag">SmartThings</em>}{s.status === 'failed' && <small className="bad-text"> {s.detail}</small>}</li>)}</ul>
        </details>
      )}

      {j.state !== 'departed' && (
        <div className="prefs">
          <div className="sec-title">Your preferences</div>
          <label className="pref"><span>Temperature</span><input type="range" min={18} max={28} step={0.5} value={j.prefs.temp} onChange={ev => setJ({ ...j, prefs: { ...j.prefs, temp: Number(ev.target.value) } })} onPointerUp={ev => act({ action: 'prefs', prefs: { temp: Number((ev.target as HTMLInputElement).value) } })} /><b>{j.prefs.temp} °C</b></label>
          <div className="pref"><span>Light</span><div className="seg">{SCENES.map(([k, l]) => <button key={k} className={j.prefs.scene === k ? 'on' : ''} onClick={() => act({ action: 'prefs', prefs: { scene: k } })}>{l}</button>)}</div></div>
          <label className="pref"><span>Curtain</span><input type="range" min={0} max={100} step={10} value={j.prefs.curtain} onChange={ev => setJ({ ...j, prefs: { ...j.prefs, curtain: Number(ev.target.value) } })} onPointerUp={ev => act({ action: 'prefs', prefs: { curtain: Number((ev.target as HTMLInputElement).value) } })} /><b>{j.prefs.curtain === 0 ? 'closed' : `${j.prefs.curtain} %`}</b></label>
          <div className="muted tiny">Used the next time your room is prepared{['preparing', 'ready', 'arrived'].includes(j.state) ? ' (or tap Prepare now)' : ''}.</div>
        </div>
      )}

      {e && !e.empty && (
        <div className="guest-energy" onClick={() => send({ type: 'setLayer', layer: 'energy', on: true })} title="Show energy in 3D">
          <span>Your room uses <b>{e.w >= 1000 ? `${(e.w / 1000).toFixed(2)} kW` : `${Math.round(e.w)} W`}</b> now · {e.kwh.toFixed(2)} kWh today</span>
          {e.avoided.kwh > 0 && <span className="eco-tag">{e.avoided.kwh.toFixed(3)} kWh saved by eco in this room today</span>}
        </div>
      )}

      {j.timeline.length > 0 && (
        <ol className="timeline">{j.timeline.slice().reverse().slice(0, 6).map((t, i) => <li key={i}><small>{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>{t.text}</li>)}</ol>
      )}
    </div>
  );
}
