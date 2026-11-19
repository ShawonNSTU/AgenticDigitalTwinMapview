'use client';
import { useRef, useState } from 'react';
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
export default function ChatPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', text: 'Ask me about the devices on this floor, for example "show all air conditioners with a problem" or "why is the bedroom warm?"' }]);
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
      <div className="msgs">{msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}{busy && <div className="msg tool">Thinking…</div>}</div>
      <form onSubmit={ask} className="row"><input value={input} onChange={e => setInput(e.target.value)} placeholder="Search devices or ask about a fault…" /><button className="pri" disabled={busy}>Send</button></form>
    </div>
  );
}
