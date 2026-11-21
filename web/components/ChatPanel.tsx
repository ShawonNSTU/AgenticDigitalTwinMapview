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
const GREETING = 'Ask me about any device in the building, for example "turn on Light 3 and dim it to 40%", "close the roller shade halfway", "which lights are on?", "show all air conditioners with a problem" or "what\'s wrong with AC-04?". Every change shows in the 3D view.';

/** The assistant: one agent (smartthings-agent) for the administrator and the technician. It controls and reads
 *  the zone's real SmartThings devices and every other (simulated) device, and finds and explains faults. */
export default function ChatPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [health, setHealth] = useState<{ ready: boolean; problem: string | null; model: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => fetch('/api/chat').then(r => r.json()).then(h => { if (alive) setHealth({ ready: !!h.ready, problem: h.problem ?? null, model: h.model ?? null }); }).catch(() => { if (alive) setHealth({ ready: false, problem: 'The assistant is not reachable.', model: null }); });
    poll(); const t = setInterval(poll, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', text: GREETING }]);
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
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history.current }) });
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
      <div className="chat-status" title={health?.model ? `Model: ${health.model}` : undefined}><i className={`dot ${health ? (health.ready ? 'ok' : 'off') : ''}`} />{health ? (health.ready ? `Assistant ready${health.model ? ` · ${health.model}` : ''}` : health.problem ?? 'Assistant not ready') : 'Checking the assistant…'}</div>
      <div className="msgs">{msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}{busy && <div className="msg tool">Thinking…</div>}</div>
      <form onSubmit={ask} className="row"><input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask or tell me what to do, e.g. make the room cosy for a movie" /><button className="pri" disabled={busy}>Send</button></form>
    </div>
  );
}
