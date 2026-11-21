'use client';
import { useEffect, useRef, useState } from 'react';
import { send, type ToRenderer } from '@/lib/bridge';

type Msg = { role: 'user' | 'assistant' | 'tool'; text: string };

/**
 * Chat with the AI agent. The agent streams SSE events:
 *   text      { text }            assistant prose
 *   tool      { name, summary }   a tool was used (shown as a small line)
 *   ui_action { ...ToRenderer }   forwarded to the Godot renderer (highlight, open, focus…)
 *   select    { id }              open a device in the side panel
 *   error     { message }
 */
type Engine = 'twin' | 'st';
const GREETING: Record<Engine, string> = {
  twin: 'Ask me about the devices on this floor, for example "show all air conditioners with a problem" or "why is the bedroom warm?"',
  st: 'I control the SmartThings Experience Zone\'s devices, for example "turn on Light 3 and dim it to 40%", "close the roller shade halfway" or "which lights are on?". You see each change in the room.',
};
const PLACEHOLDER: Record<Engine, string> = { twin: 'Search devices or ask about a fault…', st: 'e.g. make the room cosy for a movie' };

/** Two assistants: the twin's agent (agent-backend: search, faults, the whole floor) and the SmartThings agent
 *  (smartthings-agent: controls and reads the zone's devices in plain words, through the twin). */
export default function ChatPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [engine, setEngine] = useState<Engine>('twin');
  const [stUp, setStUp] = useState<boolean | null>(null);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('twin-chat-engine'); } catch { /* private mode */ }
    fetch('/api/st-agent').then(r => r.json()).then(h => {
      setStUp(!!h.ok);
      const e: Engine = saved === 'twin' || saved === 'st' ? saved : h.ok ? 'st' : 'twin';
      setEngine(e); setMsgs([{ role: 'assistant', text: GREETING[e] }]);
    }).catch(() => setStUp(false));
  }, []);
  const pick = (e: Engine) => {
    if (e === engine || busy) return;
    setEngine(e); history.current = []; setMsgs([{ role: 'assistant', text: GREETING[e] }]);
    try { localStorage.setItem('twin-chat-engine', e); } catch { /* private mode */ }
  };
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', text: GREETING.twin }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<{ role: string; content: string }[]>([]);
  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim(); if (!q || busy) return;
    setInput(''); setBusy(true);
    setMsgs(m => [...m, { role: 'user', text: q }]);
    history.current.push({ role: 'user', content: q });
    let answer = '';
    try {
      const res = await fetch(engine === 'st' ? '/api/st-agent' : '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history.current }) });
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /event: (.*)/.exec(block)?.[1]; const data = JSON.parse(/data: (.*)/s.exec(block)?.[1] ?? '{}');
          if (ev === 'text') { answer += data.text; setMsgs(m => [...m, { role: 'assistant', text: data.text }]); }
          else if (ev === 'tool') setMsgs(m => [...m, { role: 'tool', text: `${data.name}: ${data.summary}` }]);
          else if (ev === 'ui_action') send(data as ToRenderer);
          else if (ev === 'select') onSelect(data.id);
          else if (ev === 'error') setMsgs(m => [...m, { role: 'tool', text: data.message }]);
        }
      }
      history.current.push({ role: 'assistant', content: answer || '(no answer)' });
    } finally { setBusy(false); }
  }
  return (
    <div className="chat">
      <div className="seg chat-engine" role="tablist" aria-label="Assistant">
        <button type="button" className={engine === 'twin' ? 'on' : ''} onClick={() => pick('twin')}>Twin assistant</button>
        <button type="button" className={engine === 'st' ? 'on' : ''} onClick={() => pick('st')} title={stUp === false ? 'Not running: start smartthings-agent' : 'Controls the SmartThings zone in plain words'}>
          SmartThings agent <i className={`dot ${stUp ? 'ok' : stUp === false ? 'off' : ''}`} />
        </button>
      </div>
      <div className="msgs">{msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}{busy && <div className="msg tool">Thinking…</div>}</div>
      <form onSubmit={ask} className="row"><input value={input} onChange={e => setInput(e.target.value)} placeholder={PLACEHOLDER[engine]} /><button className="pri" disabled={busy}>Send</button></form>
    </div>
  );
}
