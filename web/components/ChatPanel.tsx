'use client';
import { useEffect, useState } from 'react';
import { openClimateVision } from './ClimateVision';
import { send, type ToRenderer } from '@/lib/bridge';
import { AgentPanel, ErrorNote } from './agent/Agent';
import AgentPopup from './agent/AgentPopup';

type Brief = { stats: { rooms: number; devices: number; real: number; docs: number; events: number }; title: string; empty: boolean;
  alerts: { id: string; name: string; room: string; title: string; level: string }[]; guests: number; routines: string[] };
type Health = { ready: boolean; problem: string | null; model: string | null };

const TASKS = [
  { icon: '▦', label: 'How many rooms are on this floor?' },
  { icon: '☀', label: 'Turn on Light 3 and dim it to 40%' },
  { icon: '⚡', label: 'How much energy did we use today?' },
  { icon: '⚠', label: 'Which devices will fail next?' },
];

/** The staff assistant (administrator, technician): one agent for the whole twin, in a popup over the map. */
export default function ChatPanel({ onSelect, role = 'Administrator', right = 392 }: { onSelect: (id: string) => void; role?: string; right?: number }) {
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

  const subtitle = (
    <span className="agp-state" title={health?.problem ?? (health?.model ? `Model ${health.model}` : '')}>
      <i className={`dot ${health ? (health.ready ? 'ok' : 'off') : ''}`} />
      {health ? (health.ready ? `Ready · ${role}` : 'Not ready') : 'Checking…'}
    </span>
  );

  const home = (ask: (q: string) => void) => (
    <div className="ag-home">
      <h3>What should I do?</h3>
      <p className="muted">Ask about the floor or tell me what to change.</p>
      {health && !health.ready && health.problem && <ErrorNote text={health.problem} />}
      {brief && brief.alerts.length > 0 && (
        <section className="ag-attn"><h4>Needs attention</h4>
          {brief.alerts.map(a => (
            <div key={a.id} className={`ag-attn-row ${a.level}`}><span><b>{a.name}</b> · {a.room}<br /><small>{a.title}</small></span>
              <button type="button" onClick={() => ask(`What's wrong with ${a.id} and how do I fix it?`)}>Investigate</button></div>
          ))}
        </section>
      )}
      <div className="ag-tasks">{TASKS.map(t => <button type="button" key={t.label} onClick={() => ask(t.label)}><i>{t.icon}</i>{t.label}</button>)}</div>
    </div>
  );

  return (
    <AgentPopup right={right} top={64}>
      {ctl => <AgentPanel endpoint="/api/chat" history="/api/chat/history" home={home} title="Twin Assistant" subtitle={subtitle} ctl={ctl} placeholder="Ask anything or tell me what to do…"
        onUi={a => { if (a.type === 'climateVision') openClimateVision({ smoke: !!a.smoke }); else send(a as ToRenderer); }} onSelect={onSelect} />}
    </AgentPopup>
  );
}
