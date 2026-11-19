'use client';
import { useCallback, useEffect, useState } from 'react';
import TwinView from '@/components/TwinView';
import DevicePanel from '@/components/DevicePanel';
import ChatPanel from '@/components/ChatPanel';
import Timeline from '@/components/Timeline';
import { send, type FromRenderer } from '@/lib/bridge';

type Sim = { t: number; playing: boolean; scenario: string; scenarios: { key: string; name: string }[] };
type Row = { id: string; label: string; room: string; health: string };

export default function Home() {
  const [sim, setSim] = useState<Sim | null>(null);
  const [devices, setDevices] = useState<Row[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'devices' | 'agent'>('agent');

  // Clock and health changes come from the simulated platform over SSE.
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('clock', e => { const s = JSON.parse((e as MessageEvent).data); setSim(s); send({ type: 'setTime', t: s.t }); });
    es.addEventListener('health', () => fetch('/api/devices').then(r => r.json()).then(x => setDevices(x.devices)));
    fetch('/api/devices').then(r => r.json()).then(x => setDevices(x.devices));
    return () => es.close();
  }, []);
  useEffect(() => { if (sim) send({ type: 'setScenario', key: sim.scenario }); }, [sim?.scenario]);

  const select = useCallback((id: string) => { setSel(id); send({ type: 'focusDevice', id }); }, []);
  const onEvent = useCallback((m: FromRenderer) => {
    if (m.type === 'deviceClicked') setSel(m.id);
    if (m.type === 'partClicked') setSel(m.id);
    if (m.type === 'deviceClosed') setSel(null);
  }, []);
  const bad = devices.filter(d => d.health !== 'ok');

  return (
    <main className="app">
      <header className="row between">
        <b>Agentic Digital Twin · Map View</b>
        <span className="muted">{devices.length} devices · {bad.length ? `${bad.length} need attention` : 'all healthy'}</span>
      </header>
      <section className="stage"><TwinView onEvent={onEvent} /></section>
      <aside className="side">
        {sel ? <DevicePanel id={sel} t={sim ? Math.round(sim.t * 10) / 10 : 10} onClose={() => setSel(null)} onSelect={select} /> : (
          <>
            <div className="tabs row"><button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>Agent</button><button className={tab === 'devices' ? 'on' : ''} onClick={() => setTab('devices')}>Devices</button></div>
            {tab === 'agent' ? <ChatPanel onSelect={select} /> : (
              <div className="list">{devices.map(d => (
                <div key={d.id} className="part" onClick={() => select(d.id)} onMouseEnter={() => send({ type: 'highlight', ids: [d.id] })} onMouseLeave={() => send({ type: 'clearHighlight' })}>
                  <span><i className={`dot ${d.health}`} />{d.id} · {d.label}</span><em className="muted">{d.room}</em>
                </div>))}
              </div>
            )}
          </>
        )}
      </aside>
      <footer><Timeline sim={sim} /></footer>
    </main>
  );
}
