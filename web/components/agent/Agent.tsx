'use client';
// The agentic assistant UI, shared by the staff panel and the guest page.
//
// A conversation is a list of RUNS, not chat bubbles: each run shows the request, the steps the agent is taking
// (live), what it changed (one chip per device, ✓ or ✕, click to see it in 3D), the answer, the facts it is based on
// (from the knowledge graph), follow-ups it suggests, and cards for decisions it offers (save as a routine).
// Server events (docs/contracts/agent-api.md): step, text, result, sources, suggestions, offer, ui_action, select,
// error, done.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type Step = { text: string; at: number; done: boolean };
export type Result = { device_id: string; label: string; ok: boolean; summary?: string; error?: string; offline?: boolean };
export type Source = { id: string; kind: string; title: string; devices: string[] };
export type Run = {
  id: number; ask: string; startedAt: number; endedAt?: number; status: 'running' | 'done' | 'error' | 'stopped';
  steps: Step[]; text: string; error?: string; results: Result[]; sources: Source[]; suggestions: string[];
  offer?: { kind: string; text: string; state: 'open' | 'done' | 'dismissed' }; shown: string[];
};
export type UiAction = { type: string; [k: string]: unknown };

/** Runs one request after another against a streaming endpoint; keeps the conversation for follow-ups. */
export function useAgent(endpoint: string, opts: { onUi?: (a: UiAction) => void; onSelect?: (id: string) => void; onText?: (t: string) => void } = {}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const cb = useRef(opts); cb.current = opts;

  const patch = (id: number, f: (r: Run) => Run) => setRuns(rs => rs.map(r => (r.id === id ? f(r) : r)));

  const ask = useCallback(async (q: string) => {
    q = q.trim(); if (!q || busy) return;
    const id = ++seq.current;
    const history = runs.flatMap(r => [{ role: 'user', content: r.ask }, ...(r.text ? [{ role: 'assistant', content: r.text }] : [])]).slice(-12);
    setRuns(rs => [...rs.map(r => (r.offer?.state === 'open' ? { ...r, offer: { ...r.offer, state: 'dismissed' as const } } : r)),
      { id, ask: q, startedAt: Date.now(), status: 'running', steps: [], text: '', results: [], sources: [], suggestions: [], shown: [] }]);
    setBusy(true);
    const ac = new AbortController(); abort.current = ac;
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [...history, { role: 'user', content: q }] }), signal: ac.signal });
      if (!res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1]?.trim();
          let data: any = {}; try { data = JSON.parse(/^data: (.*)$/ms.exec(block)?.[1] ?? '{}'); } catch { /* skip */ }
          if (ev === 'step') patch(id, r => ({ ...r, steps: [...r.steps.map(s => ({ ...s, done: true })), { text: String(data.text || data.stage), at: Date.now(), done: false }] }));
          else if (ev === 'text') { patch(id, r => ({ ...r, text: r.text ? `${r.text}\n${data.text}` : String(data.text) })); cb.current.onText?.(String(data.text)); }
          else if (ev === 'result') patch(id, r => ({ ...r, results: data.results ?? [] }));
          else if (ev === 'sources') patch(id, r => ({ ...r, sources: data.items ?? [] }));
          else if (ev === 'suggestions') patch(id, r => ({ ...r, suggestions: data.items ?? [] }));
          else if (ev === 'offer') patch(id, r => ({ ...r, offer: { kind: data.kind, text: data.text, state: 'open' } }));
          else if (ev === 'error') patch(id, r => ({ ...r, error: String(data.message ?? 'Something went wrong') }));
          else if (ev === 'ui_action') { cb.current.onUi?.(data); if (data.type === 'highlight' && Array.isArray(data.ids)) patch(id, r => ({ ...r, shown: data.ids })); }
          else if (ev === 'select') cb.current.onSelect?.(String(data.id));
        }
      }
      patch(id, r => ({ ...r, status: r.error && !r.text ? 'error' : 'done', endedAt: Date.now(), steps: r.steps.map(s => ({ ...s, done: true })) }));
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      patch(id, r => ({ ...r, status: stopped ? 'stopped' : 'error', endedAt: Date.now(), error: stopped ? undefined : `The assistant is not reachable (${(e as Error).message}).`, steps: r.steps.map(s => ({ ...s, done: true })) }));
    } finally { setBusy(false); abort.current = null; }
  }, [busy, endpoint, runs]);

  const stop = () => abort.current?.abort();
  const reset = () => { if (!busy) setRuns([]); };
  const setOffer = (id: number, state: 'done' | 'dismissed') => patch(id, r => (r.offer ? { ...r, offer: { ...r.offer, state } } : r));
  return { runs, busy, ask, stop, reset, setOffer };
}

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const KIND: Record<string, string> = { summary: '▦', room: '⌂', device: '◉', history: '↺', alert: '⚠', guest: '☺', routine: '↻', technician: '⚒' };

function Timeline({ run, open, toggle }: { run: Run; open: boolean; toggle: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (run.status !== 'running') return; const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, [run.status]);
  const took = (run.endedAt ?? now) - run.startedAt;
  const running = run.status === 'running';
  return (
    <div className={`ag-steps ${open || running ? 'open' : ''}`}>
      <button type="button" className="ag-steps-head" onClick={toggle} aria-expanded={open || running}>
        <span className={`ag-pulse ${running ? 'on' : run.status}`} />
        <span>{running ? (run.steps[run.steps.length - 1]?.text ?? 'Starting') + '…' : run.status === 'stopped' ? 'Stopped' : run.status === 'error' ? 'Could not finish' : `Done in ${secs(took)}`}</span>
        {run.steps.length > 0 && <em>{run.steps.length} step{run.steps.length === 1 ? '' : 's'}</em>}
      </button>
      {(open || running) && run.steps.length > 0 && (
        <ol>{run.steps.map((s, i) => <li key={i} className={s.done ? 'done' : 'now'}><i />{s.text}</li>)}</ol>
      )}
    </div>
  );
}

function OfferCard({ run, onAsk, onClose }: { run: Run; onAsk: (q: string) => void; onClose: (s: 'done' | 'dismissed') => void }) {
  const [name, setName] = useState('');
  if (!run.offer || run.offer.state !== 'open') return run.offer?.state === 'done' ? <div className="ag-offer done">Saving as a routine…</div> : null;
  return (
    <form className="ag-offer" onSubmit={e => { e.preventDefault(); if (!name.trim()) return; onClose('done'); onAsk(`Save this as a routine called ${name.trim()}`); }}>
      <b>↻ {run.offer.text}</b>
      <div className="row"><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Movie mix" aria-label="Routine name" />
        <button className="pri" disabled={!name.trim()}>Save</button><button type="button" className="ghost" onClick={() => onClose('dismissed')}>Not now</button></div>
    </form>
  );
}

/** One run: request, live steps, changes, answer, sources, offers, follow-ups. */
export function RunCard({ run, last, busy, onAsk, onFocus, setOffer }: { run: Run; last: boolean; busy: boolean; onAsk: (q: string) => void; onFocus: (ids: string[]) => void; setOffer: (s: 'done' | 'dismissed') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`ag-run ${run.status}`}>
      <header className="ag-ask"><span>{run.ask}</span></header>
      <Timeline run={run} open={open} toggle={() => setOpen(o => !o)} />
      {run.results.length > 0 && (
        <div className="ag-changes">
          {run.results.map((r, i) => (
            <button type="button" key={i} className={`ag-chip ${r.ok ? 'ok' : 'bad'}`} onClick={() => onFocus([r.device_id])} title={r.ok ? r.summary : r.error}>
              <i>{r.ok ? '✓' : '✕'}</i><b>{r.label}</b>{r.ok ? (r.summary && r.summary !== 'done' ? <span>{r.summary}</span> : null) : <span>{r.offline ? 'offline' : r.error}</span>}
            </button>
          ))}
        </div>
      )}
      {run.text && <div className="ag-answer">{run.text}</div>}
      {run.error && <div className="ag-error">⚠ {run.error}</div>}
      {run.shown.length > 1 && !run.results.length && <button type="button" className="ag-link" onClick={() => onFocus(run.shown)}>Show {run.shown.length} devices in 3D</button>}
      {run.sources.length > 0 && (
        <div className="ag-sources"><small>Based on</small>
          {run.sources.map((s, i) => (
            <button type="button" key={s.id} className="ag-src" onClick={() => s.devices.length && onFocus(s.devices)} disabled={!s.devices.length} title={s.title}>
              <i>{KIND[s.kind] ?? '•'}</i>{i + 1}. {s.title}
            </button>
          ))}
        </div>
      )}
      <OfferCard run={run} onAsk={onAsk} onClose={setOffer} />
      {last && !busy && run.suggestions.length > 0 && (
        <div className="ag-next">{run.suggestions.map(s => <button type="button" key={s} onClick={() => onAsk(s)}>{s}</button>)}</div>
      )}
    </article>
  );
}

/** The input: grows with the text, Enter sends, Shift+Enter is a new line, Stop while the agent works. */
export function Composer({ busy, onAsk, onStop, placeholder, tools, value, setValue }: { busy: boolean; onAsk: (q: string) => void; onStop: () => void; placeholder: string; tools?: ReactNode; value?: string; setValue?: (v: string) => void }) {
  const [own, setOwn] = useState('');
  const text = value ?? own, set = setValue ?? setOwn;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = ref.current; if (t) { t.style.height = 'auto'; t.style.height = `${Math.min(140, t.scrollHeight)}px`; } }, [text]);
  const go = () => { if (!text.trim() || busy) return; onAsk(text); set(''); };
  return (
    <form className="ag-composer" onSubmit={e => { e.preventDefault(); go(); }}>
      <textarea ref={ref} rows={1} value={text} onChange={e => set(e.target.value)} placeholder={placeholder} aria-label="Ask or instruct the assistant"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }} />
      <div className="ag-composer-bar">
        <div className="ag-tools">{tools}</div>
        {busy ? <button type="button" className="ag-stop" onClick={onStop} aria-label="Stop">■ Stop</button>
          : <button className="pri ag-send" disabled={!text.trim()} aria-label="Send">↑</button>}
      </div>
    </form>
  );
}

/** The whole panel: a home screen until the first request, then the runs, and the composer. */
export function AgentPanel({ endpoint, home, placeholder, onUi, onSelect, onText, tools, status, value, setValue, agentRef }: {
  endpoint: string; home: (ask: (q: string) => void) => ReactNode; placeholder: string; onUi?: (a: UiAction) => void; onSelect?: (id: string) => void; onText?: (t: string) => void;
  tools?: ReactNode; status?: ReactNode; value?: string; setValue?: (v: string) => void; agentRef?: React.MutableRefObject<{ ask: (q: string) => void } | null>;
}) {
  const a = useAgent(endpoint, { onUi, onSelect, onText });
  if (agentRef) agentRef.current = { ask: a.ask };
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [a.runs]);
  const focus = (ids: string[]) => { onUi?.({ type: 'highlight', ids }); if (ids.length === 1) onUi?.({ type: 'focusDevice', id: ids[0] }); };
  return (
    <div className="ag">
      <div className="ag-bar">{status}{a.runs.length > 0 && <button type="button" className="ghost ag-new" onClick={a.reset} disabled={a.busy} title="Start a new conversation">＋ New</button>}</div>
      <div className="ag-feed">
        {a.runs.length === 0 ? home(a.ask) : a.runs.map((r, i) => (
          <RunCard key={r.id} run={r} last={i === a.runs.length - 1} busy={a.busy} onAsk={a.ask} onFocus={focus} setOffer={s => a.setOffer(r.id, s)} />
        ))}
        <div ref={end} />
      </div>
      <Composer busy={a.busy} onAsk={a.ask} onStop={a.stop} placeholder={placeholder} tools={tools} value={value} setValue={setValue} />
    </div>
  );
}
