'use client';
import { useEffect, useState } from 'react';
import { send, type ToRenderer } from '@/lib/bridge';
import { AgentPanel } from './agent/Agent';

type Brief = { stats: { rooms: number; devices: number; real: number; docs: number; events: number }; title: string; empty: boolean;
  alerts: { id: string; name: string; room: string; title: string; level: string }[]; guests: number; routines: string[] };
type Health = { ready: boolean; problem: string | null; model: string | null };

const TASKS = [
  { icon: '▦', label: 'How many rooms are on this floor?' },
  { icon: '◉', label: 'Which devices are real SmartThings devices?' },
  { icon: '☀', label: 'Turn on Light 3 and dim it to 40%' },
  { icon: '↻', label: 'Run movie night in the SmartThings Experience Zone' },
  { icon: '☺', label: 'Check a guest into the SmartThings Experience Zone for 2 nights' },
  { icon: '↺', label: 'What happened in the last hour?' },
];

/** The staff assistant (administrator, technician): one agent for the whole twin. */
export default function ChatPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch('/api/chat').then(r => r.json()).then(h => alive && setHealth({ ready: !!h.ready, problem: h.problem ?? null, model: h.model ?? null })).catch(() => alive && setHealth({ ready: false, problem: 'The assistant is not reachable.', model: null }));
      fetch('/api/kg').then(r => r.json()).then(b => alive && setBrief(b)).catch(() => {});
    };
    poll(); const t = setInterval(poll, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const status = (
    <div className="ag-status" title={health?.problem ?? (health?.model ? `Model ${health.model}` : '')}>
      <i className={`dot ${health ? (health.ready ? 'ok' : 'off') : ''}`} />
      <b>Assistant</b>
      <span>{health ? (health.ready ? health.model ?? 'ready' : 'not ready') : 'checking…'}</span>
      {brief && <span className="ag-kg" title="What the assistant knows: the floor plan, every device and everything done since">· knows {brief.stats.rooms} rooms, {brief.stats.devices} devices, {brief.stats.events} events</span>}
    </div>
  );

  const home = (ask: (q: string) => void) => (
    <div className="ag-home">
      <h3>What should I do?</h3>
      <p className="muted">I can control any device (real or simulated), answer anything about {brief?.title ?? 'this floor'}, run and save routines, check guests in and out, and find and fix faults. Every change shows in the 3D view.</p>
      {health && !health.ready && <div className="ag-error">⚠ {health.problem}</div>}
      {brief && brief.alerts.length > 0 && (
        <section className="ag-attn"><h4>Needs attention</h4>
          {brief.alerts.map(a => (
            <div key={a.id} className={`ag-attn-row ${a.level}`}><span><b>{a.name}</b> · {a.room}<br /><small>{a.title}</small></span>
              <button type="button" onClick={() => ask(`What's wrong with ${a.id} and how do I fix it?`)}>Investigate</button></div>
          ))}
        </section>
      )}
      {brief && (
        <div className="ag-facts">
          <div><b>{brief.stats.rooms}</b><small>rooms</small></div><div><b>{brief.stats.devices}</b><small>devices</small></div>
          <div><b>{brief.stats.real}</b><small>real SmartThings</small></div><div><b>{brief.guests}</b><small>guests in</small></div>
        </div>
      )}
      <div className="ag-tasks">{TASKS.map(t => <button type="button" key={t.label} onClick={() => ask(t.label)}><i>{t.icon}</i>{t.label}</button>)}</div>
    </div>
  );

  return <AgentPanel endpoint="/api/chat" home={home} status={status} placeholder="Ask anything or tell me what to do…"
    onUi={a => send(a as ToRenderer)} onSelect={onSelect} />;
}
