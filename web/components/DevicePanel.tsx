'use client';
import { useEffect, useState } from 'react';
import { send } from '@/lib/bridge';

type Part = { key: string; name: string; value: string; health: string; inferred: boolean };
type Finding = { lvl: string; title: string; conf: string; ev: string[]; steps: { t: string; p: string; go?: string }[] } | null;
type Device = { id: string; label: string; name: string; health: string; parts: Part[]; finding: Finding };

/** Selected device: health, finding, guided steps and live parts. Polls the simulated platform. */
export default function DevicePanel({ id, t, onClose, onSelect }: { id: string; t: number; onClose: () => void; onSelect: (id: string) => void }) {
  const [d, setD] = useState<Device | null>(null);
  const [step, setStep] = useState(0);
  useEffect(() => { setStep(0); }, [id]);
  useEffect(() => { let on = true; fetch(`/api/devices/${id}`).then(r => r.json()).then(x => on && setD(x)); return () => { on = false; }; }, [id, t]);
  if (!d) return <div className="panel">Loading…</div>;
  const f = d.finding;
  const go = (i: number) => { if (!f) return; const s = Math.max(0, Math.min(f.steps.length - 1, i)); setStep(s); send({ type: 'focusPart', id, part: f.steps[s].p }); };
  return (
    <div className="panel">
      <div className="row between"><div><b>{d.id} · {d.label}</b><div className="muted">{d.name}</div></div><span className={`badge ${d.health}`}>{d.health}</span></div>
      <div className="row"><button onClick={() => send({ type: 'openDevice', id })}>Open in place</button><button onClick={() => { send({ type: 'closeDevice' }); onClose(); }}>Back to floor</button></div>
      {f && (
        <div className={`finding ${f.lvl}`}>
          <b>{f.title}</b><div className="muted">{f.conf}</div>
          <ul>{f.ev.map(e => <li key={e}>{e}</li>)}</ul>
          <b>Guided troubleshooting</b>
          <ol>{f.steps.map((s, i) => <li key={i} className={i === step ? 'cur' : ''} onClick={() => go(i)}>{s.t}</li>)}</ol>
          <div className="row">
            <button onClick={() => go(step - 1)}>Previous</button>
            {step < f.steps.length - 1 ? <button className="pri" onClick={() => go(step + 1)}>Done, next step</button>
              : <button className="pri" onClick={() => fetch('/api/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fix: true, playing: true }) })}>Mark as fixed</button>}
            {f.steps[step].go && <button onClick={() => onSelect(f.steps[step].go!)}>Open {f.steps[step].go}</button>}
          </div>
        </div>
      )}
      <div className="parts">{d.parts.map(p => (
        <div key={p.key} className="part" onClick={() => send({ type: 'focusPart', id, part: p.key })}>
          <span><i className={`dot ${p.health}`} />{p.name}{p.inferred && <em> (inferred)</em>}</span><b>{p.value}</b>
        </div>))}
      </div>
    </div>
  );
}
