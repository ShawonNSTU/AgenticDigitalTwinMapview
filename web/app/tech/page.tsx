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
type Pred = { key: string; deviceId: string; name: string; type: string; roomName: string; title: string; etaText: string; etaMin: number | null; confidence: number; basis: string; evidence: string[]; action: string; part: string | null; partName: string | null };
type Disp = { deviceId: string; tech: { name: string } | null; fromName: string; status: string };
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
  const [preds, setPreds] = useState<Pred[]>([]);
  const [disp, setDisp] = useState<Disp[]>([]);
  const [psel, setPsel] = useState<string | null>(null);   // a predicted failure picked (no alert yet)
  const loadPreds = useCallback(() => fetch('/api/predictions').then(r => r.json()).then(x => { setPreds(x.predictions); setDisp(x.dispatches); }).catch(() => {}), []);
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
    // predicted failures: tell the technician when a new one is due within the hour
    const seenPred = new Set<string>();
    es.addEventListener('predicted', e => {
      const x = JSON.parse((e as MessageEvent).data);
      setPreds(x.predictions); setDisp(x.dispatches);
      for (const p of x.predictions as Pred[]) if (!seenPred.has(p.key)) { seenPred.add(p.key); if (p.etaMin != null && p.etaMin <= 60) { setToast(`Predicted · ${p.deviceId} ${p.name} in ${p.roomName}: ${p.title}, in ${p.etaText}`); setTimeout(() => setToast(''), 6000); } }
    });
    loadPreds();
    // a resolved alert means the device is fixed: it leaves the list everywhere at once
    es.addEventListener('cleared', e => {
      const c = JSON.parse((e as MessageEvent).data);
      setToast(`${c.deviceId} is back to normal${c.by ? ` · resolved by ${c.by}` : ''}`); setTimeout(() => setToast(''), 6000);
      load();
    });
    const h = setInterval(load, 5000);
    return () => { es.close(); clearInterval(h); };
  }, [load, loadPreds]);
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
    // the technician reached the device on the map: on site, and the x-ray opens at the failing part
    if (m.type === 'techRoute' && m.phase === 'arrived') {
      fetch('/api/predictions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: m.id, status: 'on_site' }) }).then(() => loadPreds());
      const p = predsRef.current.find(x => x.deviceId === m.id);
      setToast(`On site at ${m.id}${p?.partName ? ` · opening the ${p.partName}` : ''}`); setTimeout(() => setToast(''), 5000);
      send({ type: 'openDevice', id: m.id, ...(p?.part ? { part: p.part } : {}) });
    }
  }, [loadPreds]);
  const predsRef = useRef<Pred[]>([]);
  useEffect(() => { predsRef.current = preds; }, [preds]);
  const dispatchTo = async (id: string, reason: string) => {
    const r = await fetch('/api/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: id, reason }) });
    if (r.ok) { const x = await r.json(); send({ type: 'dispatchRoute', id }); setToast(`${x.tech?.name ?? 'Technician'} on the way to ${id} from ${x.fromName}`); setTimeout(() => setToast(''), 5000); loadPreds(); }
  };
  const p0 = preds.find(x => x.deviceId === psel) ?? null;

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
          {preds.length > 0 && <div className="row between pred-title"><b>Predicted</b><span className="muted small">before guests notice</span></div>}
          {preds.slice(0, 6).map(p => (
            <button key={p.key} className={`alert-row predicted ${psel === p.deviceId && !sel ? 'on' : ''}`} onClick={() => { setSel(null); setPsel(p.deviceId); send({ type: 'focusDevice', id: p.deviceId }); }}>
              <span className="dev-ico"><DeviceIcon type={p.type} size={16} /></span>
              <span className="grow"><b>{p.deviceId} · {p.title}</b><small>{p.roomName} · {Math.round(p.confidence * 100)} % · {p.basis.replace('-', ' ')}</small></span>
              <em className="eta-chip">{p.etaMin != null ? `in ${p.etaText}` : p.etaText}</em>
            </button>
          ))}
        </div>
        {toast && <div className="toasts"><div className="toast bad">{toast}</div></div>}
      </section>
      <aside className="side">
        {!a && p0 ? (
          <div className="panel">
            <div className="dev-head">
              <span className="dev-ico big"><DeviceIcon type={p0.type} size={26} /></span>
              <div className="grow"><b>{p0.deviceId} · {p0.name}</b><div className="muted">{p0.roomName} · predicted, not failed yet</div></div>
              <span className="badge predicted">in {p0.etaText}</span>
            </div>
            <div className="finding predicted"><b>{p0.title}</b><div className="muted">{Math.round(p0.confidence * 100)} % confidence · {p0.basis.replace('-', ' ')}</div><ul>{p0.evidence.map(e => <li key={e}>{e}</li>)}</ul></div>
            <div className="sec-title">Recommended</div><div>{p0.action}</div>
            {(() => { const d = disp.find(x => x.deviceId === p0.deviceId && x.status !== 'done'); return (
              <div className="btns">
                {d ? <span className="muted">{d.tech?.name ?? 'Technician'} {d.status === 'on_site' ? 'on site' : `on the way from ${d.fromName}`}</span>
                  : <button className="pri" onClick={() => dispatchTo(p0.deviceId, p0.title)}>Send me there · show the route</button>}
                <button onClick={() => send({ type: 'openDevice', id: p0.deviceId, ...(p0.part ? { part: p0.part } : {}) })}>Open 3D twin{p0.partName ? ` at the ${p0.partName}` : ''}</button>
                {d && d.status !== 'done' && <button onClick={() => fetch('/api/predictions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: p0.deviceId, status: 'on_site' }) }).then(loadPreds)}>I’m on site</button>}
              </div>); })()}
          </div>
        ) : !a ? <div className="panel"><div className="muted">Pick an alert or a predicted failure.</div></div> : (
          <div className="panel">
            <div className="dev-head">
              <span className="dev-ico big"><DeviceIcon type={a.type} size={26} /></span>
              <div className="grow"><b>{a.deviceId} · {a.label}</b><div className="muted">{a.roomName} · raised {ago(a.since)}{a.assignee ? ` · assigned to ${a.assignee.name}` : ' · unassigned'}</div></div>
              <span className={`badge ${a.level}`}>{a.level === 'fault' ? 'Fault' : 'Watch'}</span>
            </div>
            <div className="btns">
              <button className="pri" onClick={() => send({ type: 'openDevice', id: a.deviceId })}>Open 3D twin</button>
              <button onClick={() => send({ type: 'focusDevice', id: a.deviceId })}>Show on floor</button>
              <button onClick={() => dispatchTo(a.deviceId, a.title)}>Route me there</button>
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
            {summary && <div className="ai-sum">{summary}</div>}
            <details className="fold"><summary>Service notes</summary>
            <div className="docs"><b>{a.docs.title}</b>{a.docs.fault && <p><b>{a.docs.fault.name}:</b> {a.docs.fault.what}</p>}
              <p className="muted">Parts: {a.docs.parts.map(p => `${p.name}${p.measured ? '' : ' (not measured)'}`).join(', ')}</p></div></details>
            {a.events.length > 0 && <details className="fold"><summary>Recent events <i>{a.events.length}</i></summary>
            <div className="recs">{a.events.slice().reverse().map((e, i) => <div key={i} className="rec">{e.at ? `${ago(e.at)} · ` : ''}{e.text}</div>)}</div></details>}
            <div className="sec-title">Record the investigation</div>
            <div className="rec-form">
              <div className="seg">{STATUS.filter(s => s !== 'new').map(s => <button key={s} className={form.status === s ? 'on' : ''} onClick={() => setForm(f => ({ ...f, status: s }))}>{s}</button>)}</div>
              <input placeholder="Cause found (if known)" value={form.cause} onChange={e => setForm(f => ({ ...f, cause: e.target.value }))} />
              <input placeholder="Action taken" value={form.action} onChange={e => setForm(f => ({ ...f, action: e.target.value }))} />
              <textarea placeholder="Notes" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              <div className="row"><input className="grow" placeholder="Your name" value={form.by} onChange={e => setForm(f => ({ ...f, by: e.target.value }))} /><button className="pri" onClick={record}>Save record</button></div>
            </div>
            <details className="fold"><summary>Maintenance history <i>{recs.length}</i></summary>
            <div className="recs">{recs.length ? recs.map(r => <div key={r.id} className="rec"><b>{r.status}</b> · {new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.by}{r.cause && <div>Cause: {r.cause}</div>}{r.action && <div>Action: {r.action}</div>}{r.notes && <div className="muted">{r.notes}</div>}</div>) : <div className="muted">Nothing recorded yet.</div>}</div></details>
          </div>
        )}
      </aside>
    </main>
  );
}
