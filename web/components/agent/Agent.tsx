'use client';
// The agentic assistant UI, shared by the staff panel and the guest page.
//
// A conversation is a list of RUNS, not chat bubbles: each run shows the request, the steps the agent is taking
// (live), what it changed (one chip per device, ✓ or ✕, click to see it in 3D), the answer, the facts it is based on
// (from the knowledge graph), follow-ups it suggests, and cards for decisions it offers (save as a routine).
// Server events (docs/contracts/agent-api.md): step, text, result, sources, suggestions, offer, ui_action, select,
// error, done.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Rich, useTyped } from './Rich';
import { PopupHeader, type PopupControls } from './AgentPopup';

export type Step = { text: string; at: number; done: boolean };
export type Result = { device_id: string; label: string; ok: boolean; summary?: string; error?: string; offline?: boolean };
export type Source = { id: string; kind: string; title: string; devices: string[] };
export type Run = {
  id: number; ask: string; startedAt: number; endedAt?: number; status: 'running' | 'done' | 'error' | 'stopped';
  steps: Step[]; text: string; error?: string; results: Result[]; sources: Source[]; suggestions: string[];
  offer?: { kind: string; text: string; state: 'open' | 'done' | 'dismissed' }; shown: string[];
  reasoning: string; choices: string[]; cards: Card[];
  todo: Todo[]; parallel: boolean;
  restored?: boolean;   // brought back from the history: shown as it was, not typed again
};
export type Todo = { id: number; title: string; skill: string; status: 'pending' | 'running' | 'done' | 'needs_input' | 'failed'; summary?: string; at?: number; took?: number };
export type Card = { kind: string; title?: string; link?: string; pin?: string | null; room?: string; until?: string; label?: string };
export type UiAction = { type: string; [k: string]: unknown };

/** Runs one request after another against a streaming endpoint; keeps the conversation for follow-ups. */
export type ChatBrief = { id: string; title: string; createdAt: number; updatedAt: number; turns: number; preview: string };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** Runs one request after another against a streaming endpoint; keeps the conversation for follow-ups. With a
 *  history endpoint, each conversation is saved on the server after every answer and can be opened again later
 *  (lib/chatroutes.ts). */
export function useAgent(endpoint: string, opts: { onUi?: (a: UiAction) => void; onSelect?: (id: string) => void; onText?: (t: string) => void; history?: string } = {}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [chatId, setChatId] = useState(newId);
  const [chats, setChats] = useState<ChatBrief[] | null>(null);
  const [saveError, setSaveError] = useState('');
  const hist = opts.history;
  const savedSig = useRef('');
  const dirty = useRef(false);   // something new since the conversation was opened or saved
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const cb = useRef(opts); cb.current = opts;

  const patch = (id: number, f: (r: Run) => Run) => setRuns(rs => rs.map(r => (r.id === id ? f(r) : r)));

  const ask = useCallback(async (q: string) => {
    q = q.trim(); if (!q || busy) return;
    const id = ++seq.current;
    dirty.current = true;
    const history = runs.flatMap(r => [{ role: 'user', content: r.ask }, ...(r.text ? [{ role: 'assistant', content: r.text }] : [])]).slice(-12);
    setRuns(rs => [...rs.map(r => (r.offer?.state === 'open' ? { ...r, offer: { ...r.offer, state: 'dismissed' as const } } : r)),
      { id, ask: q, startedAt: Date.now(), status: 'running', steps: [], text: '', results: [], sources: [], suggestions: [], shown: [], reasoning: '', choices: [], cards: [], todo: [], parallel: false }]);
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
          else if (ev === 'plan') patch(id, r => ({ ...r, todo: data.tasks ?? [], parallel: !!data.parallel }));
          else if (ev === 'task') patch(id, r => ({ ...r, todo: r.todo.map(t => t.id !== data.id ? t : { ...t, status: data.status, summary: data.summary ?? t.summary,
            at: data.status === 'running' ? Date.now() : t.at, took: data.status !== 'running' && t.at ? Date.now() - t.at : t.took }) }));
          else if (ev === 'reasoning') patch(id, r => ({ ...r, reasoning: (r.reasoning + String(data.text ?? '')).slice(-6000) }));
          else if (ev === 'choices') patch(id, r => ({ ...r, choices: data.items ?? [] }));
          else if (ev === 'card') patch(id, r => ({ ...r, cards: [...r.cards, data as Card] }));
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

  // save the conversation once a run has ended (and when an offer is answered); nothing while it streams
  useEffect(() => {
    if (!hist || busy || runs.length === 0 || !dirty.current) return;
    const body = JSON.stringify({ runs: runs.map(({ restored, ...r }) => r) });
    const sig = `${chatId}:${body.length}:${runs.length}:${runs[runs.length - 1].status}:${runs.map(r => r.offer?.state ?? '').join()}`;
    if (sig === savedSig.current) return;
    const t = setTimeout(() => {
      fetch(`${hist}/${chatId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); savedSig.current = sig; dirty.current = false; setSaveError(''); return r.json(); })
        .then((b: ChatBrief) => setChats(cs => cs ? [b, ...cs.filter(c => c.id !== b.id)] : cs))
        .catch(e => setSaveError(`Couldn't save this conversation (${(e as Error).message}).`));
    }, 400);
    return () => clearTimeout(t);
  }, [hist, busy, runs, chatId]);

  const loadChats = useCallback(() => {
    if (!hist) return;
    fetch(hist).then(r => r.json()).then(b => setChats(Array.isArray(b.chats) ? b.chats : [])).catch(() => setChats([]));
  }, [hist]);
  /** Bring a saved conversation back; asking again carries on from it. */
  const open = useCallback(async (id: string) => {
    if (!hist || busy) return false;
    const b = await fetch(`${hist}/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!b || !Array.isArray(b.runs)) return false;
    const rs = (b.runs as Run[]).map((r, i) => ({ ...r, id: i + 1, restored: true, status: r.status === 'running' ? 'stopped' as const : r.status,
      steps: r.steps ?? [], results: r.results ?? [], sources: r.sources ?? [], suggestions: r.suggestions ?? [], shown: r.shown ?? [], reasoning: r.reasoning ?? '',
      choices: r.choices ?? [], cards: r.cards ?? [], todo: r.todo ?? [], text: r.text ?? '' }));
    seq.current = rs.length;
    savedSig.current = '';
    setChatId(id);
    setRuns(rs);
    return true;
  }, [hist, busy]);
  const remove = useCallback(async (id: string) => {
    if (!hist) return;
    await fetch(`${hist}/${id}`, { method: 'DELETE' }).catch(() => {});
    setChats(cs => cs?.filter(c => c.id !== id) ?? cs);
    if (id === chatId) { setRuns([]); setChatId(newId()); }
  }, [hist, chatId]);

  const stop = () => abort.current?.abort();
  const reset = () => { if (!busy) { setRuns([]); setChatId(newId()); savedSig.current = ''; } };
  const setOffer = (id: number, state: 'done' | 'dismissed') => { dirty.current = true; patch(id, r => (r.offer ? { ...r, offer: { ...r.offer, state } } : r)); };
  return { runs, busy, ask, stop, reset, setOffer, chatId, chats, loadChats, open, remove, saveError, hasHistory: !!hist };
}

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const KIND: Record<string, string> = { summary: '▦', room: '⌂', device: '◉', history: '↺', alert: '⚠', guest: '☺', routine: '↻', technician: '⚒' };

function Timeline({ run, open, toggle }: { run: Run; open: boolean; toggle: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (run.status !== 'running') return; const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, [run.status]);
  const took = (run.endedAt ?? now) - run.startedAt;
  const running = run.status === 'running';
  return (
    <div className={`ag-steps ${open ? 'open' : ''}`}>
      <button type="button" className="ag-steps-head" onClick={toggle} aria-expanded={open}>
        <span className={`ag-pulse ${running ? 'on' : run.status}`} />
        <span>{running ? (run.steps[run.steps.length - 1]?.text ?? 'Starting') + '…' : run.status === 'stopped' ? 'Stopped' : run.status === 'error' ? 'Could not finish' : `Done in ${secs(took)}`}</span>
        {run.steps.length > 0 && <em>{run.steps.length} step{run.steps.length === 1 ? '' : 's'}</em>}
      </button>
      {open && run.steps.length > 0 && (
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

/** While the agent works and has nothing to show yet: what it is doing now, animated. */
function Thinking({ run }: { run: Run }) {
  const now = run.steps[run.steps.length - 1]?.text ?? 'Thinking';
  return (
    <div className="ag-thinking" role="status" aria-live="polite">
      <div className="ag-orb"><i /><i /><i /></div>
      <div className="ag-thinking-body"><b>{now}…</b>
        <div className="ag-skel"><span /><span /><span /></div>
      </div>
    </div>
  );
}

/** The model's reasoning, streamed live while it thinks; folded once the answer is there. */
function Reasoning({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const live = run.status === 'running' && !run.text;
  useEffect(() => { if (live && box.current) box.current.scrollTop = box.current.scrollHeight; }, [run.reasoning, live]);
  if (!run.reasoning.trim()) return null;
  const show = live || open;
  return (
    <div className={`ag-reason ${live ? 'ag-reason-live' : ''}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={show}><i>✦</i>{live ? 'Reasoning…' : 'Reasoning'}<em>{show ? '▾' : '▸'}</em></button>
      {show && <div ref={box} className="ag-reason-text">{run.reasoning.trim()}</div>}
    </div>
  );
}

function PassCard({ c }: { c: Card }) {
  const [qr, setQr] = useState('');
  const url = c.link ?? '';
  useEffect(() => { if (url) QRCode.toDataURL(url, { margin: 1, width: 132 }).then(setQr).catch(() => {}); }, [url]);
  const [copied, setCopied] = useState('');
  const copy = (v: string, what: string) => navigator.clipboard?.writeText(v).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1200); }).catch(() => {});
  return (
    <div className="ag-card">
      {qr && <img src={qr} alt="Guest pass QR code" width={96} height={96} />}
      <div className="ag-card-body">
        <b>{c.title}</b>
        {c.label && <small>{c.label}</small>}
        {c.until && <small>Until {c.until}</small>}
        {c.pin && <button type="button" className="rc-code big" onClick={() => copy(c.pin!, 'pin')} title="Copy PIN"><span>{c.pin}</span><i>{copied === 'pin' ? '✓' : '⧉'}</i></button>}
        <div className="row">
          <a className="rc-link" href={url} target="_blank" rel="noopener noreferrer">Open guest page<i>↗</i></a>
          <button type="button" className="ghost" onClick={() => copy(url, 'link')}>{copied === 'link' ? 'Copied ✓' : 'Copy link'}</button>
        </div>
      </div>
    </div>
  );
}

function Answer({ text, animate, onTyped, onAsk }: { text: string; animate: boolean; onTyped: (typing: boolean) => void; onAsk: (q: string) => void }) {
  const { shown, typing } = useTyped(text, animate);
  useEffect(() => { onTyped(typing); }, [typing, onTyped]);
  return <div className="ag-answer"><Rich text={shown} caret={typing} onAsk={onAsk} /></div>;
}

/** The agent's plan for a message with several tasks: a to-do list it works through, live. */
function TodoList({ run }: { run: Run }) {
  const done = run.todo.filter(t => t.status === 'done').length;
  const icon = (s: Todo['status']) => s === 'done' ? '✓' : s === 'failed' ? '✕' : s === 'needs_input' ? '?' : s === 'running' ? '' : '';
  return (
    <div className="ag-todo">
      <div className="ag-todo-head"><b>Plan</b><span>{done}/{run.todo.length} done · {run.parallel ? 'in parallel' : 'one by one'}</span>
        <i className="ag-todo-bar"><i style={{ width: `${(100 * run.todo.filter(t => t.status !== 'pending' && t.status !== 'running').length) / Math.max(1, run.todo.length)}%` }} /></i></div>
      <ol>{run.todo.map(t => (
        <li key={t.id} className={t.status}>
          <span className="ag-todo-ico">{icon(t.status)}</span>
          <div><b>{t.title}</b>{t.summary && t.status !== 'running' && <small>{t.summary.replace(/\*\*/g, '')}</small>}{t.status === 'running' && <small>Working…</small>}</div>
          {t.took != null && t.status !== 'running' && <em>{secs(t.took)}</em>}
        </li>
      ))}</ol>
    </div>
  );
}

/** One run: request, live steps, changes, answer, sources, offers, follow-ups. */
export function RunCard({ run, last, busy, onAsk, onFocus, setOffer }: { run: Run; last: boolean; busy: boolean; onAsk: (q: string) => void; onFocus: (ids: string[]) => void; setOffer: (s: 'done' | 'dismissed') => void }) {
  const [open, setOpen] = useState(false);
  // the reply is revealed word by word; what comes after it (sources, cards, follow-ups) appears once it is typed
  const [typing, setTyping] = useState(false);
  const started = useRef(run.status === 'running').current;
  const animate = !run.restored && (started || last);
  const onTyped = useCallback((t: boolean) => setTyping(t), []);
  const after = !typing;
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
      <Reasoning run={run} />
      {run.todo.length > 0 && <TodoList run={run} />}
      {run.status === 'running' && !run.text && !run.error && !run.todo.length && !run.reasoning.trim() && <Thinking run={run} />}
      {run.text && <Answer text={run.text} animate={animate} onTyped={onTyped} onAsk={q => !busy && onAsk(q)} />}
      {after && run.cards.map((c, i) => c.kind === 'guest_pass' ? <PassCard key={i} c={c} /> : null)}
      {after && last && !busy && run.choices.length > 0 && (
        <div className="ag-choices">{run.choices.map(c => <button type="button" key={c} onClick={() => onAsk(c)}>{c}</button>)}</div>
      )}
      {run.error && <ErrorNote text={run.error} />}
      {run.shown.length > 1 && !run.results.length && <button type="button" className="ag-link" onClick={() => onFocus(run.shown)}>Show {run.shown.length} devices in 3D</button>}
      {after && run.sources.length > 0 && (
        <div className="ag-sources"><small>Based on</small>
          {run.sources.map((s, i) => (
            <button type="button" key={s.id} className="ag-src" onClick={() => s.devices.length && onFocus(s.devices)} disabled={!s.devices.length} title={s.title}>
              <i>{KIND[s.kind] ?? '•'}</i>{i + 1}. {s.title}
            </button>
          ))}
        </div>
      )}
      {after && <OfferCard run={run} onAsk={onAsk} onClose={setOffer} />}
      {after && last && !busy && run.suggestions.length > 0 && (
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
export function AgentPanel({ endpoint, history, home, placeholder, onUi, onSelect, onText, tools, title, subtitle, ctl, value, setValue, agentRef }: {
  endpoint: string; history?: string; home: (ask: (q: string) => void) => ReactNode; placeholder: string; onUi?: (a: UiAction) => void; onSelect?: (id: string) => void; onText?: (t: string) => void;
  tools?: ReactNode; title: string; subtitle: ReactNode; ctl?: PopupControls; value?: string; setValue?: (v: string) => void; agentRef?: React.MutableRefObject<{ ask: (q: string) => void } | null>;
}) {
  const a = useAgent(endpoint, { onUi, onSelect, onText, history });
  // the launcher shows progress while the popup is closed
  const last = a.runs[a.runs.length - 1];
  const report = ctl?.onActivity;
  const todoDone = last?.todo.filter(t => t.status !== 'pending' && t.status !== 'running').length ?? 0, todoTotal = last?.todo.length ?? 0;
  useEffect(() => { report?.({ busy: a.busy, done: todoDone, total: todoTotal }); }, [report, a.busy, todoDone, todoTotal]);
  if (agentRef) agentRef.current = { ask: a.ask };
  const [showHist, setShowHist] = useState(false);
  const [del, setDel] = useState('');   // the conversation asking "delete?"
  const end = useRef<HTMLDivElement>(null);
  // follow the newest run while it streams and types
  useEffect(() => {
    const t = setInterval(() => { const f = end.current?.parentElement; if (f && f.scrollHeight - f.scrollTop - f.clientHeight < 160) end.current?.scrollIntoView({ block: 'end' }); }, 120);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [a.runs.length, a.chatId]);
  const focus = (ids: string[]) => { onUi?.({ type: 'highlight', ids }); if (ids.length === 1) onUi?.({ type: 'focusDevice', id: ids[0] }); };
  const toggleHist = () => { if (!showHist) a.loadChats(); setShowHist(h => !h); };
  return (
    <div className="ag">
      <PopupHeader title={title} subtitle={subtitle} ctl={ctl} historyOn={showHist}
        onHistory={a.hasHistory ? (a.busy ? undefined : toggleHist) : undefined}
        onNew={() => { a.reset(); setShowHist(false); }} canNew={!a.busy && (a.runs.length > 0 || showHist)} />
      {showHist ? (
        <div className="ag-feed ag-hist">
          <h3>Conversations</h3>
          {a.chats == null ? <p className="muted">Loading…</p> : a.chats.length === 0 ? <p className="muted">No saved conversations yet. They are kept here after each answer.</p> : (
            <ul>{a.chats.map(c => (
              <li key={c.id} className={c.id === a.chatId ? 'cur' : ''}>
                <button type="button" className="ag-hist-open" onClick={async () => { if (await a.open(c.id)) setShowHist(false); }}>
                  <b>{c.title}</b>
                  {c.preview && <small>{c.preview}</small>}
                  <em>{when(c.updatedAt)} · {c.turns} message{c.turns === 1 ? '' : 's'}{c.id === a.chatId ? ' · open now' : ''}</em>
                </button>
                {del === c.id ? (
                  <span className="ag-hist-ask"><button type="button" className="danger" onClick={() => { a.remove(c.id); setDel(''); }}>Delete</button><button type="button" className="ghost" onClick={() => setDel('')}>Keep</button></span>
                ) : <button type="button" className="ag-hist-del" aria-label={`Delete ${c.title}`} title="Delete" onClick={() => setDel(c.id)}>✕</button>}
              </li>
            ))}</ul>
          )}
        </div>
      ) : (
        <div className="ag-feed">
          {a.runs.length === 0 ? home(a.ask) : a.runs.map((r, i) => (
            <RunCard key={`${a.chatId}-${r.id}`} run={r} last={i === a.runs.length - 1} busy={a.busy} onAsk={a.ask} onFocus={focus} setOffer={s => a.setOffer(r.id, s)} />
          ))}
          {a.saveError && <ErrorNote text={a.saveError} />}
          <div ref={end} />
        </div>
      )}
      <Composer busy={a.busy} onAsk={q => { setShowHist(false); a.ask(q); }} onStop={a.stop} placeholder={placeholder} tools={tools} value={value} setValue={setValue} />
    </div>
  );
}

/** "14:05" today, "Yesterday 14:05", else "12 Nov 14:05". */
function when(t: number) {
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  return diff === 0 ? hm : diff === 1 ? `Yesterday ${hm}` : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
}

/** An error in one plain sentence; the technical detail (URLs, logs) folded under it. */
export function ErrorNote({ text }: { text: string }) {
  const m = /^(.*?[.!?])(\s|$)([\s\S]*)$/.exec(text.trim());
  const head = m ? m[1] : text, rest = m ? m[3].trim() : '';
  return (
    <div className="ag-error">⚠ {head}
      {rest && <details className="ag-error-more"><summary>Details</summary><code>{rest}</code></details>}
    </div>
  );
}
