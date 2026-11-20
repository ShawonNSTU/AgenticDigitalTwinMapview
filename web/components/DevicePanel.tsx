'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { send } from '@/lib/bridge';
import { DeviceIcon } from '@/components/DevicePalette';
import DeviceControls, { type Cmd } from '@/components/DeviceControls';

type Part = { key: string; name: string; value: string; health: string; inferred: boolean };
type Finding = { lvl: string; title: string; conf: string; ev: string[]; steps: { t: string; p: string; go?: string }[]; simulated?: boolean } | null;
type FaultOpt = { key: string; name: string; what: string; parts: string[] };
type Active = { key: string; name: string; level: string; severity: number; developing: boolean; parts: string[] } | null;
type Device = { id: string; type: string; label: string; name: string; health: string; parts: Part[]; finding: Finding; fault: Active; faults: FaultOpt[]; readings: Record<string, unknown>; overrides: Record<string, unknown> | null; online?: boolean };
type Rec = { id: string; at: number; by: string; status: string; cause: string; action: string; notes: string };

const LEVELS = [{ key: 'early', name: 'Early' }, { key: 'developing', name: 'Developing' }, { key: 'severe', name: 'Severe' }] as const;
const json = (r: Response) => r.json();

/** Selected device: health, fault simulation, diagnosis with guided repair, and live components. Refreshes every second. */
export default function DevicePanel({ id, onClose, onSelect, onMove, onRemove }: { id: string; t?: number; onClose: () => void; onSelect: (id: string) => void; onMove?: (id: string) => void; onRemove?: (id: string) => void }) {
  const [d, setD] = useState<Device | null>(null);
  const [step, setStep] = useState(0);
  const [exploded, setExploded] = useState(true);
  const [twinOpen, setTwinOpen] = useState(false);
  const [pick, setPick] = useState<string>('');
  const [level, setLevel] = useState<string>('developing');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const alive = useRef(true);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [cmdMsg, setCmdMsg] = useState('');
  useEffect(() => {
    fetch(`/api/devices/${id}/commands`).then(json).then(x => setCmds(x.commands ?? [])).catch(() => setCmds([]));
    const loadRecs = () => fetch(`/api/maintenance?device=${id}`).then(json).then(x => setRecs(x.records ?? [])).catch(() => {});
    loadRecs(); const h = setInterval(loadRecs, 5000); return () => clearInterval(h);
  }, [id]);
  const runCmd = async (command: string, args: Record<string, unknown> = {}, confirmed = false) => {
    const r = await fetch(`/api/devices/${id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args, confirmed, by: 'host' }) });
    const x = await r.json().catch(() => ({}));
    setCmdMsg(r.ok ? '' : x.error ?? 'Command failed');
    send({ type: 'refreshDevices' });
    load();
  };

  const load = useCallback(() => fetch(`/api/devices/${id}`).then(json).then(x => { if (alive.current) setD(x); }).catch(() => {}), [id]);
  useEffect(() => { alive.current = true; setStep(0); setPick(''); setErr(''); setTwinOpen(false); load(); const h = setInterval(load, 1000); return () => { alive.current = false; clearInterval(h); }; }, [id, load]);
  // keep the picker on the active fault, or on the first fault of this device type
  // follow the running fault only when it changes, so the 1 s refresh never overrides the technician's choice
  const synced = useRef('');
  useEffect(() => { synced.current = ''; }, [id]);
  useEffect(() => {
    if (!d) return;
    if (!pick) setPick(d.fault?.key ?? d.faults?.[0]?.key ?? '');
    const sig = d.fault ? `${d.fault.key}:${d.fault.level}` : '';
    if (sig !== synced.current) { synced.current = sig; if (d.fault) { setPick(d.fault.key); setLevel(d.fault.level); } }
  }, [d, pick]);

  if (!d) return <div className="panel"><div className="muted">Loading…</div></div>;
  if ((d as unknown as { error?: string }).error) return <div className="panel"><div className="muted">This device is no longer on the floor.</div><button onClick={onClose}>Back</button></div>;
  const f = d.finding;
  const active = d.fault;
  const affected = new Set(active?.parts ?? []);
  const go = (i: number) => { if (!f) return; const s = Math.max(0, Math.min(f.steps.length - 1, i)); setStep(s); send({ type: 'focusPart', id, part: f.steps[s].p }); };
  const openTwin = () => { send({ type: 'openDevice', id }); setExploded(true); setTwinOpen(true); };

  async function inject() {
    if (!pick) return;
    setBusy(true); setErr('');
    const r = await fetch(`/api/devices/${id}/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: pick, level }) });
    const x = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(x.error ?? 'Could not start the fault'); return; }
    setD(x); setStep(0);
    // show it where it happens: the whole twin, with the damaged components glowing; the repair steps zoom in
    if (!twinOpen) openTwin();
  }
  async function clear() {
    setBusy(true);
    const r = await fetch(`/api/devices/${id}/fault`, { method: 'DELETE' });
    setBusy(false);
    if (r.ok) { setD(await r.json()); setStep(0); }
  }
  const chosen = d.faults.find(o => o.key === pick);

  return (
    <div className="panel">
      <div className="dev-head">
        <span className="dev-ico big"><DeviceIcon type={d.type} size={26} /></span>
        <div className="grow"><b>{d.id} · {d.label}</b><div className="muted">{d.name.split(' · ').slice(1).join(' · ')}</div></div>
        <span className={`badge ${d.health}`}>{d.health === 'ok' ? 'Normal' : d.health === 'watch' ? 'Watch' : 'Fault'}</span>
      </div>
      <div className="btns">
        <button className="pri" onClick={openTwin}>Open digital twin</button>
        <button onClick={() => { send({ type: 'setLayer', layer: 'exploded', on: !exploded }); setExploded(!exploded); }}>{exploded ? 'Assemble' : 'Explode'}</button>
        <button onClick={() => { send({ type: 'closeDevice' }); setTwinOpen(false); onClose(); }}>Floor</button>
      </div>
      {(onMove || onRemove) && <div className="btns small">
        {onMove && <button onClick={() => onMove(id)}>Move on map</button>}
        {onRemove && <button className="danger" onClick={() => onRemove(id)}>Remove</button>}
      </div>}

      {cmds.length > 0 && (
        <section className="ctl-box">
          <div className="lab-head"><b>Controls</b>{d.online === false ? <span className="off-tag">Offline</span> : <span className="muted">what this device supports</span>}</div>
          <DeviceControls dev={{ type: d.type, readings: d.readings, overrides: d.overrides }} commands={cmds} run={runCmd} disabled={d.online === false} />
          {cmdMsg && <div className="bad-text">{cmdMsg}</div>}
        </section>
      )}

      {d.faults.length > 0 && (
        <section className={`lab ${active ? 'lab-on' : ''}`}>
          <div className="lab-head">
            <b>Fault simulation</b>
            {active ? <span className="sim-tag">Simulated · {LEVELS.find(l => l.key === active.level)?.name}</span> : <span className="muted">for training and diagnosis</span>}
          </div>
          {active && (
            <div className="sev">
              <div className="row between"><span>{active.name}</span><span className="muted">{active.developing ? 'developing…' : 'fully developed'}</span></div>
              <div className="sev-bar"><i style={{ width: `${Math.round(active.severity * 100)}%` }} /></div>
            </div>
          )}
          <div className="fault-list" role="radiogroup" aria-label="Fault to simulate">
            {d.faults.map(o => (
              <button key={o.key} role="radio" aria-checked={pick === o.key} className={`fault-opt ${pick === o.key ? 'on' : ''} ${active?.key === o.key ? 'running' : ''}`} onClick={() => setPick(o.key)}>
                <b>{o.name}</b><span>{o.what}</span>
              </button>
            ))}
          </div>
          {chosen && <div className="muted">Affects: {chosen.parts.map(k => d.parts.find(p => p.key === k)?.name ?? k).join(', ')}</div>}
          <div className="seg" role="radiogroup" aria-label="Severity">
            {LEVELS.map(l => <button key={l.key} role="radio" aria-checked={level === l.key} className={level === l.key ? 'on' : ''} onClick={() => setLevel(l.key)}>{l.name}</button>)}
          </div>
          <div className="row">
            <button className="pri grow" disabled={busy || !pick} onClick={inject}>{active && active.key === pick ? (active.level === level ? 'Restart fault' : 'Change severity') : active ? 'Switch to this fault' : 'Inject fault'}</button>
            {active && <button disabled={busy} onClick={clear}>Clear fault</button>}
          </div>
          {err && <div className="muted" style={{ color: 'var(--fault)' }}>{err}</div>}
        </section>
      )}

      {f && (
        <div className={`finding ${f.lvl}`}>
          <b>{f.title}</b><div className="muted">{f.conf}</div>
          <ul>{f.ev.map(e => <li key={e}>{e}</li>)}</ul>
          <b>Guided repair</b>
          <ol>{f.steps.map((s, i) => <li key={i} className={i === step ? 'cur' : ''} onClick={() => go(i)}>{s.t}</li>)}</ol>
          <div className="row">
            <button onClick={() => go(step - 1)} disabled={step === 0}>Previous</button>
            {step < f.steps.length - 1 ? <button className="pri" onClick={() => go(step + 1)}>Done, next step</button>
              : <button className="pri" onClick={() => f.simulated ? clear() : fetch('/api/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fix: true }) })}>Mark as fixed</button>}
            {f.steps[step].go && <button onClick={() => onSelect(f.steps[step].go!)}>Open {f.steps[step].go}</button>}
          </div>
        </div>
      )}
      <div className="sec-title">Components <span className="muted">· live where the device reports it; “not measured” parts are shown for explanation only</span></div>
      <div className="parts">{d.parts.map(p => (
        <div key={p.key} className={`part ${affected.has(p.key) ? 'hit' : ''}`} onClick={() => { if (!twinOpen) openTwin(); send({ type: 'focusPart', id, part: p.key }); }}>
          <span><i className={`dot ${p.health}`} />{p.name}{p.inferred && <em className="not-measured"> not measured</em>}</span><b>{p.value}</b>
        </div>))}
      </div>
      <div className="sec-title">Maintenance history</div>
      {recs.length === 0 ? <div className="muted">No investigations recorded for this device.</div> : (
        <div className="recs">{recs.slice(0, 6).map(r => (
          <div key={r.id} className="rec"><b>{r.status}</b> · {new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.by}
            {r.cause && <div>Cause: {r.cause}</div>}{r.action && <div>Action: {r.action}</div>}{r.notes && <div className="muted">{r.notes}</div>}</div>))}
        </div>
      )}
    </div>
  );
}
