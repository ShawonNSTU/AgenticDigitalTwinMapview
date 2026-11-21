'use client';
import { useEffect, useRef, useState } from 'react';

type Action = { device_id: string; label: string; type: string; command: string; args: Record<string, unknown>; summary: string };
type Result = Action & { ok: boolean; error?: string; offline?: boolean };
type Msg = { role: 'user' | 'assistant'; content: string; plan?: { actions: Action[]; ask_first: boolean; state: 'asking' | 'done' | 'declined' }; results?: Result[] };
type Lang = 'en-US' | 'bn-BD';

const EXAMPLES: Record<Lang, string[]> = {
  'en-US': ['Set the AC to 24 degrees and dim the lights', 'Make the room comfortable for sleeping', 'Turn off the TV', 'Start cleaning the room'],
  'bn-BD': ['এসি ২৪ ডিগ্রি করো', 'লাইট কম করো', 'টিভি বন্ধ করো', 'ঘুমানোর জন্য রুম ঠিক করো'],
};

// The browser's speech recognition (Chrome, Edge, Safari); not every browser has it.
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const SpeechRec = (): (new () => Rec) | null => typeof window === 'undefined' ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);

/** The guest's room assistant: type or speak (English or Bangla); it shows what it will do, asks when the
 *  request is a broad wish, and reports each device's result, including any that did not respond. */
export default function GuestAssistant({ token, onUi }: { token: string; onUi: (a: { type: string; ids?: string[] }) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', content: 'Hi! I can control this room for you. Ask in your own words, by typing or with the microphone.' }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState<Lang>('en-US');
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const rec = useRef<Rec | null>(null);
  const [hasMic, setHasMic] = useState(false);   // Firefox has no speech input: no microphone button there
  useEffect(() => { setHasMic(!!SpeechRec()); }, []);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  const say = (t: string) => {
    if (!speak || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = lang; window.speechSynthesis.speak(u);
  };

  // which assistant answers: the room assistant (agent-backend) or the SmartThings agent (smartthings-agent)
  const [engine, setEngine] = useState<'room' | 'st'>('room');
  const [stUp, setStUp] = useState(false);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('guest-assistant-engine'); } catch { /* private mode */ }
    fetch('/api/st-agent').then(r => r.json()).then(h => { setStUp(!!h.ok); setEngine(saved === 'room' || saved === 'st' ? saved : h.ok ? 'st' : 'room'); }).catch(() => {});
  }, []);
  const pickEngine = (e: 'room' | 'st') => { setEngine(e); try { localStorage.setItem('guest-assistant-engine', e); } catch { /* private mode */ } };

  const stream = async (history: Msg[], confirm?: Action[]) => {
    setBusy(true);
    const r = await fetch(engine === 'st' ? `/api/guest/${token}/st-agent` : `/api/guest/${token}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.filter(m => m.content).map(m => ({ role: m.role, content: m.content })), confirm }) });
    if (!r.body) { setBusy(false); return; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    const add = (m: Partial<Msg>) => setMsgs(ms => {
      const last = ms[ms.length - 1];
      if (last?.role === 'assistant' && !last.content && !last.plan && !last.results) return [...ms.slice(0, -1), { ...last, ...m } as Msg];
      return [...ms, { role: 'assistant', content: '', ...m } as Msg];
    });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(chunk)?.[1]; const data = JSON.parse(/data: (.*)/s.exec(chunk)?.[1] ?? '{}');
        if (ev === 'text') { add({ content: data.text }); say(data.text); }
        if (ev === 'plan') add({ content: '', plan: { actions: data.actions, ask_first: data.ask_first, state: data.ask_first ? 'asking' : 'done' } });
        if (ev === 'result') add({ content: '', results: data.results });
        if (ev === 'ui_action') onUi(data);
        if (ev === 'error') add({ content: `⚠ ${data.message}` });
      }
    }
    setBusy(false);
  };

  const send = (q: string) => {
    if (!q.trim() || busy) return;
    const next = [...msgs, { role: 'user' as const, content: q.trim() }];
    setMsgs(next); setText('');
    stream(next);
  };
  const decide = (idx: number, yes: boolean) => {
    const m = msgs[idx];
    if (!m.plan) return;
    setMsgs(ms => ms.map((x, i) => i === idx ? { ...x, plan: { ...x.plan!, state: yes ? 'done' : 'declined' } } : x));
    if (yes) stream([...msgs, { role: 'user', content: lang === 'bn-BD' ? 'হ্যাঁ, করো' : 'Yes, go ahead' }], m.plan.actions);
    else setMsgs(ms => [...ms, { role: 'assistant', content: lang === 'bn-BD' ? 'ঠিক আছে, কিছু বদলাইনি।' : 'OK, I left everything as it is.' }]);
  };
  const mic = () => {
    const R = SpeechRec();
    if (!R) { setMsgs(ms => [...ms, { role: 'assistant', content: 'Voice input is not available in this browser. Please type instead.' }]); return; }
    if (listening) { rec.current?.stop(); return; }
    const r = new R(); r.lang = lang; r.interimResults = true; r.continuous = false;
    r.onresult = e => { const t = Array.from(e.results).map((x: any) => x[0].transcript).join(' '); setText(t); if (e.results[e.results.length - 1].isFinal) { r.stop(); send(t); } };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };

  return (
    <div className="assist">
      <div className="assist-log">
        {msgs.map((m, i) => (
          <div key={i} className={`amsg ${m.role}`}>
            {m.content && <p>{m.content}</p>}
            {m.plan && (
              <div className="aplan">
                {m.plan.actions.map((a, k) => <div key={k} className="aplan-row"><b>{a.label}</b><span>{a.summary}</span></div>)}
                {m.plan.state === 'asking' && <div className="row"><button className="pri" onClick={() => decide(i, true)}>Do it</button><button onClick={() => decide(i, false)}>Not now</button></div>}
                {m.plan.state === 'declined' && <em className="muted">Cancelled</em>}
              </div>
            )}
            {m.results && (
              <div className="aresults">
                {m.results.map((r, k) => <div key={k} className={`ares ${r.ok ? 'ok' : 'bad'}`}><i>{r.ok ? '✓' : '✕'}</i><b>{r.label}</b><span>{r.ok ? r.summary : r.offline ? 'not responding (offline)' : r.error}</span></div>)}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="amsg assistant"><p className="muted">…</p></div>}
        <div ref={end} />
      </div>
      <div className="assist-examples">{EXAMPLES[lang].map(e => <button key={e} onClick={() => send(e)} disabled={busy}>{e}</button>)}</div>
      <form className="assist-in" onSubmit={e => { e.preventDefault(); send(text); }}>
        {hasMic && <button type="button" className={`mic ${listening ? 'on' : ''}`} onClick={mic} aria-label={listening ? 'Stop listening' : 'Speak'} title="Speak">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
        </button>}
        <input value={text} onChange={e => setText(e.target.value)} placeholder={lang === 'bn-BD' ? 'যেমন: এসি ২৪ ডিগ্রি করো' : 'e.g. dim the lights'} aria-label="Ask the room assistant" />
        <button className="pri" disabled={busy || !text.trim()}>Send</button>
      </form>
      <div className="assist-opts">
        <div className="seg"><button type="button" className={lang === 'en-US' ? 'on' : ''} onClick={() => setLang('en-US')}>English</button><button type="button" className={lang === 'bn-BD' ? 'on' : ''} onClick={() => setLang('bn-BD')}>বাংলা</button></div>
        <label className="muted"><input type="checkbox" checked={speak} onChange={e => setSpeak(e.target.checked)} /> Read replies aloud</label>
        <div className="seg" title="Which assistant answers"><button type="button" className={engine === 'room' ? 'on' : ''} onClick={() => pickEngine('room')}>Room assistant</button><button type="button" className={engine === 'st' ? 'on' : ''} onClick={() => pickEngine('st')} disabled={!stUp} title={stUp ? 'SmartThings agent' : 'SmartThings agent is not running'}>SmartThings agent</button></div>
      </div>
    </div>
  );
}
