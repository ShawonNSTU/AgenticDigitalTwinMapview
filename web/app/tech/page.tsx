'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import TwinView from '@/components/TwinView';
import FullscreenButton from '@/components/FullscreenButton';
import { DeviceIcon } from '@/components/DevicePalette';
import { send, type FromRenderer } from '@/lib/bridge';

type Alert = {
  key: string; deviceId: string; type: string; label: string; name: string; room: string; roomName: string; level: string; title: string; since: number; online: boolean;
  reported: string[]; confidence: string; steps: { t: string; p: string }[]; parts: { key: string; name: string; value: string; health: string; inferred: boolean }[];
  docs: { title: string; fault: { name: string; what: string } | null; parts: { key: string; name: string; measured: boolean }[] }; simulated: boolean;
  status: 'new' | 'acknowledged' | 'investigating' | 'resolved'; events: { at: number; text: string }[];
  assignee: { id: string; name: string } | null;
};
type Rec = { id: string; at: number; by: string; status: string; cause: string; action: string; notes: string };

const ago = (ms: number) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const STATUS = ['new', 'acknowledged', 'investigating', 'resolved'] as const;

/** Technician console: alerts from devices (notified as they come in), where the device is, what it reports,
 *  its recent events, troubleshooting guidance and service notes, the device's 3D twin, an AI summary of the
 *  evidence, and a record of the investigation. The technician decides the cause and the repair. */
export default function TechPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [ready, setReady] = useState(false);
  const [built, setBuilt] = useState(false);
  const [toast, setToast] = useState<string>('');
  const [recs, setRecs] = useState<Rec[]>([]);
  const [form, setForm] = useState({ status: 'investigating', cause: '', action: '', notes: '', by: 'Technician' });
  const [summary, setSummary] = useState('');
  const [summing, setSumming] = useState(false);
  const [notify, setNotify] = useState(true); // hides the button until the browser's permission is known (no SSR mismatch)
  const known = useRef(new Set<string>());
  const [techs, setTechs] = useState<{ id: string; name: string }[]>([]);
  const [me, setMe] = useState('');   // which technician is using this console ('' = everyone's alerts)
  const meRef = useRef('');
  useEffect(() => {
    fetch('/api/technicians').then(r => r.json()).then(x => setTechs(x.technicians));
    try { const m = localStorage.getItem('twin.tech') ?? ''; setMe(m); meRef.current = m; } catch { /* storage unavailable */ }
  }, []);
  const chooseMe = (id: string) => { setMe(id); meRef.current = id; try { localStorage.setItem('twin.tech', id); } catch { /* storage unavailable */ } };

  const load = useCallback(() => fetch('/api/alerts').then(r => r.json()).then(x => {
    setAlerts(x.alerts);
    known.current = new Set(x.alerts.map((a: Alert) => a.key));
  }), []);
  useEffect(() => {
    load();
    const es = new EventSource('/api/events');
    es.addEventListener('alert', e => {
      const a = JSON.parse((e as MessageEvent).data);
      if (meRef.current && a.assignee?.id !== meRef.current) { load(); return; }  // someone else's alert
      setToast(`New alert · ${a.deviceId} ${a.label} in ${a.roomName}: ${a.title}`);
      setTimeout(() => setToast(''), 6000);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(`${a.deviceId} · ${a.roomName}`, { body: a.title });
      load();
    });
    es.addEventListener('health', () => load());
    // a resolved alert means the device is fixed: it leaves the list everywhere at once
    es.addEventListener('cleared', e => {
      const c = JSON.parse((e as MessageEvent).data);
      setToast(`${c.deviceId} is back to normal${c.by ? ` · resolved by ${c.by}` : ''}`); setTimeout(() => setToast(''), 6000);
      load();
    });
    const h = setInterval(load, 5000);
    return () => { es.close(); clearInterval(h); };
  }, [load]);
  useEffect(() => { setNotify(typeof Notification === 'undefined' || Notification.permission === 'granted'); }, []);

  const a = alerts.find(x => x.deviceId === sel) ?? null;
  useEffect(() => {
    if (!sel) return;
    setSummary('');
    fetch(`/api/maintenance?device=${sel}`).then(r => r.json()).then(x => setRecs(x.records));
    send({ type: 'focusDevice', id: sel });
  }, [sel]);

  const onEvent = useCallback((m: FromRenderer) => {
    if (m.type === 'ready') setReady(true);
    if (m.type === 'floorBuilt') setBuilt(true);
    if (m.type === 'deviceClicked') setSel(m.id);
  }, []);

  const record = async () => {
    if (!a) return;
    const r = await fetch('/api/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: a.deviceId, alert: a.title, ...form }) });
    if (r.ok && form.status === 'resolved') { const x = await r.clone().json().catch(() => ({})); setToast(`${a.deviceId} resolved${x.fixed?.length ? `: ${x.fixed.join(', ')}; back to normal everywhere` : ''}`); setTimeout(() => setToast(''), 6000); }
    if (r.ok) { setForm(f => ({ ...f, cause: '', action: '', notes: '' })); fetch(`/api/maintenance?device=${a.deviceId}`).then(x => x.json()).then(x => setRecs(x.records)); load(); }
  };
  const summarise = async () => {
    if (!a) return;
    setSumming(true); setSummary('');
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: `What's wrong with ${a.deviceId}? Summarise the evidence for "${a.title}", say what is measured and what is inferred, and suggest the first checks.` }] }) });
    const reader = r.body?.getReader(); const dec = new TextDecoder(); let buf = ''; let out = '';
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(chunk)?.[1]; const data = JSON.parse(/data: (.*)/s.exec(chunk)?.[1] ?? '{}');
        if (ev === 'text') { out += (out ? '\n' : '') + data.text; setSummary(out); }
        if (ev === 'error') { out += `\n⚠ ${data.message}`; setSummary(out); }
        if (ev === 'ui_action') send(data);
      }
    }
    setSumming(false);
  };

  const shown = alerts.filter(x => (filter === 'all' || x.status !== 'resolved') && (!me || x.assignee?.id === me));
  return (
    <main className="app tech">
      <header className="topbar">
        <div className="brand"><span className="logo" /><div><b>Technician console</b><small>Alerts · investigation · maintenance</small></div></div>
        <div className="stats">
          <span className={`stat ${alerts.some(x => x.level === 'fault') ? 'warn' : 'good'}`}><b>{alerts.filter(x => x.status !== 'resolved').length}</b> open alerts</span>
          <select aria-label="Technician" value={me} onChange={e => chooseMe(e.target.value)}><option value="">All technicians</option>{techs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          {!notify && <button className="ghost" onClick={() => Notification.requestPermission().then(p => setNotify(p === 'granted'))}>Turn on notifications</button>}
          <a href="/"><button className="ghost">Floor map</button></a>
        </div>
      </header>
      <section className="stage" data-fullscreen>
        <TwinView onEvent={onEvent} ready={ready && built} />
        <FullscreenButton />
        <div className="alert-list glass">
          <div className="row between"><b>Alerts</b><div className="seg"><button className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>Open</button><button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button></div></div>
          {shown.length === 0 && <div className="muted pad">No alerts. Devices report normally.</div>}
          {shown.map(x => (
            <button key={x.key} className={`alert-row ${x.level} ${sel === x.deviceId ? 'on' : ''}`} onClick={() => setSel(x.deviceId)}>
              <span className="dev-ico"><DeviceIcon type={x.type} size={16} /></span>
              <span className="grow"><b>{x.deviceId} · {x.title}</b><small>{x.roomName} · {ago(x.since)}{x.assignee ? ` · ${x.assignee.name}` : ''}{x.simulated ? ' · simulated' : ''}</small></span>
              <em className={`st ${x.status}`}>{x.status}</em>
            </button>
          ))}
        </div>
        {toast && <div className="toasts"><div className="toast bad">{toast}</div></div>}
      </section>
      <aside className="side">
        {!a ? <div className="panel"><div className="muted">Pick an alert to investigate. New alerts appear here and as notifications.</div></div> : (
          <div className="panel">
            <div className="dev-head">
              <span className="dev-ico big"><DeviceIcon type={a.type} size={26} /></span>
              <div className="grow"><b>{a.deviceId} · {a.label}</b><div className="muted">{a.roomName} · raised {ago(a.since)}{a.assignee ? ` · assigned to ${a.assignee.name}` : ' · unassigned'}</div></div>
              <span className={`badge ${a.level}`}>{a.level === 'fault' ? 'Fault' : 'Watch'}</span>
            </div>
            <div className="btns">
              <button className="pri" onClick={() => send({ type: 'openDevice', id: a.deviceId })}>Open 3D twin</button>
              <button onClick={() => send({ type: 'focusDevice', id: a.deviceId })}>Show on floor</button>
              <button onClick={() => send({ type: 'closeDevice' })}>Floor</button>
            </div>
            <div className={`finding ${a.level}`}>
              <b>{a.title}</b><div className="muted">{a.confidence}</div>
              <ul>{a.reported.map(e => <li key={e}>{e}</li>)}</ul>
              {!a.online && <div className="bad-text">The device is offline: readings below are its last report.</div>}
            </div>
            {a.parts.length > 0 && <><div className="sec-title">Affected components</div>
              <div className="parts">{a.parts.map(p => <div key={p.key} className="part" onClick={() => send({ type: 'focusPart', id: a.deviceId, part: p.key })}><span><i className={`dot ${p.health}`} />{p.name}{p.inferred && <em className="not-measured"> not measured</em>}</span><b>{p.value}</b></div>)}</div></>}
            <div className="sec-title">Troubleshooting guidance</div>
            <ol className="steps">{a.steps.map((s, i) => <li key={i} onClick={() => send({ type: 'focusPart', id: a.deviceId, part: s.p })}>{s.t}</li>)}</ol>
            <div className="sec-title">AI summary</div>
            <button onClick={summarise} disabled={summing}>{summing ? 'Reading the evidence…' : 'Summarise the evidence and suggest checks'}</button>
            {summary && <div className="ai-sum">{summary}<div className="muted">Suggestions only: the technician confirms the cause and decides the repair.</div></div>}
            <div className="sec-title">Service notes</div>
            <div className="docs"><b>{a.docs.title}</b>{a.docs.fault && <p><b>{a.docs.fault.name}:</b> {a.docs.fault.what}</p>}
              <p className="muted">Parts: {a.docs.parts.map(p => `${p.name}${p.measured ? '' : ' (not measured)'}`).join(', ')}</p></div>
            <div className="sec-title">Recent events</div>
            <div className="recs">{a.events.length ? a.events.slice().reverse().map((e, i) => <div key={i} className="rec">{e.at ? `${ago(e.at)} · ` : ''}{e.text}</div>) : <div className="muted">No events.</div>}</div>
            <div className="sec-title">Record the investigation</div>
            <div className="rec-form">
              <div className="seg">{STATUS.filter(s => s !== 'new').map(s => <button key={s} className={form.status === s ? 'on' : ''} onClick={() => setForm(f => ({ ...f, status: s }))}>{s}</button>)}</div>
              <input placeholder="Cause found (if known)" value={form.cause} onChange={e => setForm(f => ({ ...f, cause: e.target.value }))} />
              <input placeholder="Action taken" value={form.action} onChange={e => setForm(f => ({ ...f, action: e.target.value }))} />
              <textarea placeholder="Notes" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              <div className="row"><input className="grow" placeholder="Your name" value={form.by} onChange={e => setForm(f => ({ ...f, by: e.target.value }))} /><button className="pri" onClick={record}>Save record</button></div>
            </div>
            <div className="sec-title">Maintenance history</div>
            <div className="recs">{recs.length ? recs.map(r => <div key={r.id} className="rec"><b>{r.status}</b> · {new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.by}{r.cause && <div>Cause: {r.cause}</div>}{r.action && <div>Action: {r.action}</div>}{r.notes && <div className="muted">{r.notes}</div>}</div>) : <div className="muted">Nothing recorded yet.</div>}</div>
          </div>
        )}
      </aside>
    </main>
  );
}
