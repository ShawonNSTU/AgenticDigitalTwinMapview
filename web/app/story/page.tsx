'use client';
// Story mode: one guest's night on the 4th floor, in five chapters, on the live system. Presenter mode: → / space /
// ← and the chapter rail; ?autoplay=1 plays by itself and loops (for a screen or kiosk).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TwinView from '@/components/TwinView';
import { send, type FromRenderer } from '@/lib/bridge';
import { CHAPTERS, resetStory, type Ctx, type Dev, type Phone } from '@/lib/story';

class Stop extends Error {}

export default function Story() {
  const [ready, setReady] = useState(false);
  const [built, setBuilt] = useState(false);
  const [auto, setAuto] = useState(false);
  const [ch, setCh] = useState(0);
  const [step, setStep] = useState(-1);          // step running (or done) in the chapter
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState<{ title: string; sub?: string } | null>(null);
  const [phone, setPhone] = useState<Phone>({ kind: 'off' });
  const [stats, setStats] = useState<Record<string, string>>({});
  const devsRef = useRef<Dev[]>([]);
  const listeners = useRef(new Set<(m: FromRenderer) => void>());
  const runId = useRef(0);
  const state = useRef<Record<string, any>>({});

  useEffect(() => { setAuto(new URLSearchParams(location.search).get('autoplay') === '1'); window.focus(); }, []);

  const loadDevs = useCallback(async () => {
    const b = await fetch('/api/building').then(r => r.json()).catch(() => null);
    const ds = await fetch('/api/devices').then(r => r.json()).catch(() => null);
    const live: Record<string, any> = {};
    for (const d of (ds?.devices ?? [])) live[d.id] = d.live ?? d.readings;
    devsRef.current = (b?.devices ?? []).map((d: any) => ({ id: d.id, type: d.type, name: String(d.name).split(' · ')[0], room: d.room, readings: live[d.id] }));
  }, []);
  useEffect(() => { loadDevs(); }, [loadDevs]);

  const onEvent = useCallback((m: FromRenderer) => {
    if (m.type === 'ready') { setReady(true); send({ type: 'setInsets', left: 0, right: 380, top: 70, bottom: 150 }); }
    if (m.type === 'floorBuilt') setBuilt(true);
    for (const l of listeners.current) l(m);
  }, []);

  const ctx = useCallback((id: number): Ctx => {
    const alive = () => { if (runId.current !== id) throw new Stop(); };
    return {
      caption: (title, sub) => { alive(); setCap({ title, sub }); },
      phone: p => { alive(); setPhone(p); },
      stat: (k, v) => setStats(s => { const n = { ...s }; if (v == null) delete n[k]; else n[k] = v; return n; }),
      wait: ms => new Promise((res, rej) => { const t0 = Date.now(); const h = setInterval(() => { if (runId.current !== id) { clearInterval(h); rej(new Stop()); } else if (Date.now() - t0 >= ms) { clearInterval(h); res(); } }, 100); }),
      waitFor: (pred, ms) => new Promise((res, rej) => {
        const l = (m: FromRenderer) => { if (pred(m)) { done(); res(m); } };
        const h = setInterval(() => { if (runId.current !== id) { done(); rej(new Stop()); } }, 150);
        const t = setTimeout(() => { done(); res(null); }, ms);
        const done = () => { listeners.current.delete(l); clearInterval(h); clearTimeout(t); };
        listeners.current.add(l);
      }),
      api: async (path, init) => {
        alive();
        const r = await fetch(path, { method: init?.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, body: init?.body ? JSON.stringify(init.body) : undefined });
        return r.json().catch(() => ({}));
      },
      devs: () => devsRef.current,
      dev: name => devsRef.current.find(d => d.room === 'smartthings-experience-zone' && d.name.toLowerCase().startsWith(name.toLowerCase())),
      cmd: async (name, command, args = {}) => {
        alive();
        const d = devsRef.current.find(x => x.room === 'smartthings-experience-zone' && x.name.toLowerCase().startsWith(name.toLowerCase()));
        if (!d) return null;
        return fetch(`/api/devices/${d.id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args, confirmed: true, by: 'story' }) }).then(r => r.json());
      },
      state: state.current,
    };
  }, []);

  /** Play chapter `c` from step `from`; in autoplay, carry on to the next chapter (and loop). */
  const play = useCallback(async (c: number, from = 0, chain = false) => {
    const id = ++runId.current;
    setCh(c); setPlaying(true); setBusy(true);
    const x = ctx(id);
    try {
      if (from === 0 && (c === 0 || !chain)) { await loadDevs(); if (c === 0) await resetStory(x); }
      const steps = CHAPTERS[c].steps;
      for (let i = from; i < steps.length; i++) {
        setStep(i);
        await loadDevs();
        await steps[i](x);
        if (!chain && !auto) { setBusy(false); setPlaying(false); return; }   // presenter: one step per press
      }
      setStep(steps.length);
      if (chain || auto) {
        const next = (c + 1) % CHAPTERS.length;
        if (next === 0) { await x.wait(2500); state.current = {}; setPhone({ kind: 'off' }); }
        if (runId.current === id) play(next, 0, true);
        return;
      }
    } catch (e) { if (!(e instanceof Stop)) console.error(e); return; }
    setBusy(false); setPlaying(false);
  }, [ctx, auto, loadDevs]);

  // presenter: → / space next step (or chapter), ← previous chapter, 1-5 jump, Esc stop
  const next = useCallback(() => {
    if (busy) return;
    const steps = CHAPTERS[ch].steps;
    if (step + 1 < steps.length) play(ch, step + 1);
    else if (ch + 1 < CHAPTERS.length) { setStep(-1); play(ch + 1, 0); }
  }, [busy, ch, step, play]);
  const jump = useCallback((c: number) => { runId.current++; setBusy(false); setStep(-1); setCh(c); setTimeout(() => play(c, 0), 50); }, [play]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); jump(Math.max(0, ch - 1)); }
      else if (/^[1-5]$/.test(e.key)) jump(Number(e.key) - 1);
      else if (e.key === 'Escape') { runId.current++; setBusy(false); setPlaying(false); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [next, jump, ch]);

  // autoplay starts once the floor is up
  const started = useRef(false);
  useEffect(() => { if (auto && ready && built && !started.current) { started.current = true; setTimeout(() => play(0, 0, true), 1500); } }, [auto, ready, built, play]);

  if (typeof window !== 'undefined') (window as any).__story = { ch, step, busy, cap: cap?.title ?? null, run: runId.current };
  const chapter = CHAPTERS[ch];
  const total = useMemo(() => CHAPTERS.reduce((n, c) => n + c.steps.length, 0), []);
  const doneSteps = CHAPTERS.slice(0, ch).reduce((n, c) => n + c.steps.length, 0) + Math.max(0, step + (busy ? 0 : 1));

  return (
    <div className="story">
      <div className="story-stage"><TwinView onEvent={onEvent} ready={ready && built} loadingText="Preparing the 4th floor…" /></div>

      <header className="story-rail">
        <span className="story-brand"><b>Agentic Digital Twin</b><small>One guest, one night · 4th floor</small></span>
        <nav>
          {CHAPTERS.map((c, i) => (
            <button key={c.key} className={`${i === ch ? 'on' : ''} ${i < ch ? 'past' : ''}`} onClick={() => jump(i)} title={`${i + 1}. ${c.title}`}>
              <i>{i + 1}</i><span>{c.title}</span>
            </button>
          ))}
        </nav>
        <span className="story-stats">{Object.entries(stats).map(([k, v]) => <span key={k}><small>{k}</small><b>{v}</b></span>)}</span>
      </header>
      <div className="story-progress"><i style={{ width: `${(doneSteps / total) * 100}%` }} /></div>

      {cap && (
        <div className="story-cap" key={cap.title}>
          <small>{chapter.when} · Chapter {ch + 1}</small>
          <h2>{cap.title}</h2>
          {cap.sub && <p>{cap.sub}</p>}
        </div>
      )}

      {phone.kind !== 'off' && (
        <aside className={`story-phone ph-k-${phone.kind}`}>
          <div className="notch" />
          {phone.kind === 'pass' && (
            <div className="ph-pass">
              <small>Front desk · guest pass</small>
              <b>Room 401</b>
              <img src={phone.qr} alt="Guest pass QR code" />
              <span>{phone.room}</span>
              <em>Scan to open your room's 3D view, your key and your remote</em>
            </div>
          )}
          {phone.kind === 'guest' && (
            <div className="ph-guest">
              <div className="ph-top"><b>Room 401</b><small>{phone.status ?? ''}</small></div>
              <div className="ph-chat">
                {phone.lines.map((l, i) => (
                  <div key={i} className={`ph-msg ph-${l.who}`}>
                    <span>{l.text}</span>
                    {l.plan && <ul>{l.plan.map((p, j) => <li key={j}><b>{p.label}</b> {p.summary}</li>)}</ul>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {phone.kind === 'tech' && (
            <div className="ph-tech">
              <div className="ph-top alert"><b>Technician</b><small>{phone.alert.who}</small></div>
              <div className="ph-alert">
                <span className="sev">Severe</span>
                <b>{phone.alert.title}</b>
                <p>{phone.alert.detail}</p>
                {phone.alert.parts && <p className="parts">{phone.alert.parts}</p>}
                <div className="row"><span className="btn">Accept</span><span className="btn ghost">Route to unit</span></div>
              </div>
            </div>
          )}
        </aside>
      )}

      <footer className="story-controls">
        {!auto ? (
          <>
            <button onClick={() => jump(Math.max(0, ch - 1))} aria-label="Previous chapter">⏮</button>
            <button className="pri" onClick={next} disabled={busy}>{step < 0 ? `Start: ${chapter.title}` : busy ? 'Playing…' : step + 1 < chapter.steps.length ? 'Next' : ch + 1 < CHAPTERS.length ? `Next chapter: ${CHAPTERS[ch + 1].title}` : 'The end'}</button>
            <button onClick={() => { runId.current++; setBusy(false); setPlaying(false); }} disabled={!playing} aria-label="Stop">⏹</button>
            <a href="/story?autoplay=1">Autoplay</a>
            <small>→ / space: next · ←: back · 1–5: chapter</small>
          </>
        ) : (
          <><span className="live-dot" /> <small>Playing by itself · loops</small><a href="/story">Presenter mode</a></>
        )}
      </footer>
    </div>
  );
}
