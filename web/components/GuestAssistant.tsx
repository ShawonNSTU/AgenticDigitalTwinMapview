'use client';
import { useEffect, useRef, useState } from 'react';
import { AgentPanel, type UiAction } from './agent/Agent';

type Lang = 'en-US' | 'bn-BD';
const TASKS: Record<Lang, string[]> = {
  'en-US': ['Is my room ready?', 'Make my room comfortable', 'Movie night', 'I’m heading out for a while'],
  'bn-BD': ['লাইট কম করো', 'এসি ২৪ ডিগ্রি করো', 'টিভি বন্ধ করো', 'ঘুমানোর জন্য রুম ঠিক করো'],
};

// The browser's speech recognition (Chrome, Edge, Safari); not every browser has it.
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const SpeechRec = (): (new () => Rec) | null => typeof window === 'undefined' ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);

/** The guest's assistant: the same agent as the staff's, limited to the guest's room. Type or speak (English or
 *  Bangla); replies can be read aloud. */
export default function GuestAssistant({ token, onUi }: { token: string; onUi: (a: { type: string; ids?: string[] }) => void }) {
  const [lang, setLang] = useState<Lang>('en-US');
  const [speak, setSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const [hasMic, setHasMic] = useState(false);
  const [text, setText] = useState('');
  const rec = useRef<Rec | null>(null);
  const agent = useRef<{ ask: (q: string) => void } | null>(null);
  useEffect(() => { setHasMic(!!SpeechRec()); }, []);

  const say = (t: string) => {
    if (!speak || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = lang; window.speechSynthesis.speak(u);
  };
  const mic = () => {
    const R = SpeechRec(); if (!R) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new R(); r.lang = lang; r.interimResults = true; r.continuous = false;
    r.onresult = e => { const t = Array.from(e.results).map((x: any) => x[0].transcript).join(' '); setText(t); if (e.results[e.results.length - 1].isFinal) { r.stop(); setText(''); agent.current?.ask(t); } };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };

  const tools = (
    <>
      {hasMic && <button type="button" className={`ag-tool ${listening ? 'on' : ''}`} onClick={mic} aria-label={listening ? 'Stop listening' : 'Speak'} title="Speak">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg></button>}
      <button type="button" className="ag-tool" onClick={() => setLang(l => (l === 'en-US' ? 'bn-BD' : 'en-US'))} title="Language">{lang === 'en-US' ? 'EN' : 'বাং'}</button>
      <button type="button" className={`ag-tool ${speak ? 'on' : ''}`} onClick={() => setSpeak(s => !s)} title="Read replies aloud" aria-pressed={speak}>🔊</button>
    </>
  );
  const home = (ask: (q: string) => void) => (
    <div className="ag-home">
      <h3>{lang === 'bn-BD' ? 'কী করব?' : 'How can I help with your room?'}</h3>
      <p className="muted">{lang === 'bn-BD' ? 'নিজের ভাষায় বলুন বা লিখুন।' : 'Type or speak, in your own words.'}</p>
      <div className="ag-tasks">{TASKS[lang].map(t => <button type="button" key={t} onClick={() => ask(t)}><i>›</i>{t}</button>)}</div>
    </div>
  );
  return <AgentPanel endpoint={`/api/guest/${token}/chat`} history={`/api/guest/${token}/chat/history`} home={home} tools={tools} placeholder={lang === 'bn-BD' ? 'যেমন: এসি ২৪ ডিগ্রি করো' : 'e.g. dim the lights'}
    status={<div className="ag-status"><i className="dot ok" /><b>Room assistant</b></div>} onUi={a => onUi(a as UiAction & { ids?: string[] })} onText={say}
    value={text} setValue={setText} agentRef={agent} />;
}
