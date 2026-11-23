'use client';
import { useEffect, useRef, useState } from 'react';
import { onRenderer, send, type ClimateReadings } from '@/lib/bridge';

type Run = (id: string, command: string, args?: Record<string, unknown>) => Promise<unknown> | void;

const SPEEDS = [1, 2, 4] as const;

/** Ask for Climate Vision from anywhere (the AI agent's ui_action): opens the dock, optionally with a smoke test. */
export function openClimateVision(opts: { smoke?: boolean } = {}) {
  (window as unknown as { __cvPending?: { smoke?: boolean } }).__cvPending = opts;
  window.dispatchEvent(new CustomEvent('twin-climate', { detail: opts }));
}

/**
 * Climate Vision: the room's air drawn in 3D (heat, airflow, dust) from a live simulation that follows the real
 * AC and purifier. This dock turns it on, switches the layers, and drives the devices; the renderer reports readings.
 */
export default function ClimateVision({ room, run, onClose }: { room?: string; run: Run; onClose: () => void }) {
  const [r, setR] = useState<ClimateReadings | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [layers, setLayers] = useState({ heat: true, airflow: true, dust: true });
  const [speed, setSpeed] = useState<number>(2);
  const [people, setPeople] = useState(0);
  const [windfree, setWindfree] = useState(false);
  const started = useRef(false);

  useEffect(() => onRenderer(m => {
    if (m.type !== 'climate') return;
    if (m.error) setErr(m.error);
    if (m.readings) { setR(m.readings); setErr(''); }
  }), []);

  // the agent asked for a smoke test (before or after the dock opened)
  useEffect(() => {
    const w = window as unknown as { __cvPending?: { smoke?: boolean } };
    const take = () => { const p = w.__cvPending; w.__cvPending = undefined; if (p?.smoke) setTimeout(() => send({ type: 'climate', on: true, room, smoke: true }), 1500); };
    take();
    window.addEventListener('twin-climate', take);
    return () => window.removeEventListener('twin-climate', take);
  }, [room]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    send({ type: 'climate', on: true, room, reset: true, frame: true, speed: 2, people: 0, windfree: false, heat: true, airflow: true, dust: true });
    return () => { send({ type: 'climate', on: false }); };
  }, [room]);

  const set = (m: Omit<Extract<Parameters<typeof send>[0], { type: 'climate' }>, 'type' | 'on'>) => send({ type: 'climate', on: true, room, ...m });
  const act = async (key: string, id: string | undefined, command: string, args: Record<string, unknown> = {}) => {
    if (!id) return;
    setBusy(key);
    try { await run(id, command, args); } finally { setTimeout(() => setBusy(''), 600); }
  };
  const ids = r?.ids;
  const acSet = typeof r?.acSet === 'number' ? r.acSet : 24;
  const purFan = typeof r?.purFan === 'number' ? r.purFan : 2;
  const tone = !r ? '' : r.temp > 26 ? 'hot' : r.temp < 22 ? 'cold' : 'good';

  return (
    <div className="climate-dock glass" role="region" aria-label="Climate Vision">
      <div className="cv-head">
        <span className="cv-title"><i className="cv-orb" />Climate Vision<small>live air simulation · follows the real AC and purifier</small></span>
        <button className="hint-close" aria-label="Close Climate Vision" title="Close" onClick={onClose}>✕</button>
      </div>
      {err && <div className="bad-text cv-err">{err}</div>}
      <div className="cv-stats">
        <div className={`cv-stat ${tone}`}><small>Room air</small><b>{r ? `${r.temp.toFixed(1)} °C` : '…'}</b></div>
        <div className="cv-stat"><small>Comfortable</small><b>{r ? `${r.comfort}%` : '…'}</b><span className="cv-bar"><i style={{ width: `${r?.comfort ?? 0}%` }} /></span></div>
        <div className={`cv-stat ${r && r.pm > 35 ? 'hot' : ''}`}><small>PM2.5</small><b>{r ? r.pm : '…'}<em> µg/m³</em></b></div>
        <div className="cv-stat"><small>AC effort</small><b>{r ? (r.ac ? `${r.acLoad}%` : 'Off') : '…'}</b></div>
        <div className="cv-stat"><small>Air time</small><b>{r ? `${r.minutes.toFixed(1)} min` : '…'}</b></div>
      </div>
      {r && r.probes.length > 0 && (
        <div className="cv-probes">{r.probes.map(p => <span key={p.name} className={p.temp > 26 ? 'hot' : p.temp < 22 ? 'cold' : 'good'}>{p.name} <b>{p.temp.toFixed(1)}°</b></span>)}</div>
      )}
      <div className="cv-rows">
        <div className="cv-group">
          <small>Show</small>
          <div className="seg">
            {(['heat', 'airflow', 'dust'] as const).map(k => (
              <button key={k} className={layers[k] ? 'on' : ''} aria-pressed={layers[k]} onClick={() => { const n = { ...layers, [k]: !layers[k] }; setLayers(n); set({ [k]: n[k] }); }}>
                {k === 'heat' ? 'Heat' : k === 'airflow' ? 'Airflow' : 'Dust'}
              </button>
            ))}
          </div>
        </div>
        <div className="cv-group">
          <small>Air conditioner{ids?.ac ? ` · ${ids.ac}` : ''}</small>
          <div className="seg">
            <button className={r?.ac ? 'on' : ''} disabled={!ids?.ac || busy === 'ac'} onClick={() => act('ac', ids?.ac, 'power', { on: !r?.ac })}>{r?.ac ? 'On' : 'Off'}</button>
            <button disabled={!r?.ac || busy === 'set'} aria-label="Colder" onClick={() => act('set', ids?.ac, 'setTemperature', { celsius: Math.max(16, acSet - 1) })}>−</button>
            <span className="cv-set">{acSet.toFixed(0)}°</span>
            <button disabled={!r?.ac || busy === 'set'} aria-label="Warmer" onClick={() => act('set', ids?.ac, 'setTemperature', { celsius: Math.min(30, acSet + 1) })}>+</button>
          </div>
          <div className="seg">
            <button className={!windfree ? 'on' : ''} onClick={() => { setWindfree(false); set({ windfree: false }); }}>Normal</button>
            <button className={windfree ? 'on' : ''} title="Cool air through micro-holes, no draught" onClick={() => { setWindfree(true); set({ windfree: true }); }}>WindFree</button>
          </div>
        </div>
        <div className="cv-group">
          <small>Air purifier{ids?.purifier ? ` · ${ids.purifier}` : ''}</small>
          <div className="seg">
            <button className={r?.purifier ? 'on' : ''} disabled={!ids?.purifier || busy === 'pur'} onClick={() => act('pur', ids?.purifier, 'power', { on: !r?.purifier })}>{r?.purifier ? 'On' : 'Off'}</button>
            {[1, 3, 5].map(l => <button key={l} disabled={!r?.purifier || busy === 'purfan'} className={r?.purifier && purFan === l ? 'on' : ''} onClick={() => act('purfan', ids?.purifier, 'setFan', { level: l })}>Fan {l}</button>)}
          </div>
        </div>
        <div className="cv-group">
          <small>What if…</small>
          <div className="seg">
            <button disabled={r?.smoke} onClick={() => set({ smoke: true })}>{r?.smoke ? 'Smoke rising…' : 'Smoke test'}</button>
          </div>
          <div className="seg">
            <button aria-label="Fewer people" disabled={people === 0} onClick={() => { const n = people - 1; setPeople(n); set({ people: n }); }}>−</button>
            <span className="cv-set">{people} {people === 1 ? 'person' : 'people'}</span>
            <button aria-label="More people" disabled={people >= 8} onClick={() => { const n = people + 1; setPeople(n); set({ people: n }); }}>+</button>
          </div>
          <div className="seg">
            {SPEEDS.map(s => <button key={s} className={speed === s ? 'on' : ''} title="Time-lapse" onClick={() => { setSpeed(s); set({ speed: s }); }}>{s * 24}×</button>)}
            <button onClick={() => set({ reset: true })} title="Start again from a hot room">Reset</button>
          </div>
        </div>
      </div>
    </div>
  );
}
