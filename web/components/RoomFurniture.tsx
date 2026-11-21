'use client';
import { useCallback, useEffect, useState } from 'react';

type Item = { id: string; kind: string; group?: string; label: string };

/** Furnish a room by hand: add beds, tables, chairs, dining sets and more (placed at the best free spot that keeps
 *  the room walkable), then nudge, turn or remove them. The 3D view updates as you go. */
export default function RoomFurniture({ room }: { room: string }) {
  const [kinds, setKinds] = useState<{ kind: string; label: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [kind, setKind] = useState('bed');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => fetch(`/api/furniture?room=${encodeURIComponent(room)}`).then(r => r.json()).then(x => { setKinds(x.kinds); setItems(x.furniture); }), [room]);
  useEffect(() => { load(); }, [load]);
  const [sel, setSel] = useState<string | null>(null);   // the item whose move buttons are shown
  const call = async (method: string, body: object) => {
    const r = await fetch('/api/furniture', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json(); setMsg(r.ok ? '' : d.error); load();
  };
  // one row per set (a dining set's table and chairs move together)
  const rows = items.filter((it, i) => !it.group || items.findIndex(x => x.group === it.group) === i);
  const step = 0.25;
  const nice = (t: string) => (t.includes('_') || t === t.toLowerCase() ? t.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : t);
  return (
    <div className="furn">
      <div className="row"><select value={kind} onChange={e => setKind(e.target.value)}>{kinds.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select><button onClick={() => call('POST', { room, kind })}>Add</button></div>
      {msg && <div className="bad-text">{msg}</div>}
      <div className="furn-list">{rows.map(it => (
        <div key={it.id} className={`furn-row ${sel === it.id ? 'on' : ''}`} onClick={() => setSel(sel === it.id ? null : it.id)}>
          <span>{items.filter(x => it.group && x.group === it.group).length > 1 ? 'Dining set' : nice(it.label)}</span>
          {sel === it.id ? (
            <div className="nudge" onClick={e => e.stopPropagation()}>
              <button title="Move left" onClick={() => call('PATCH', { id: it.id, dx: -step })}>←</button>
              <button title="Move right" onClick={() => call('PATCH', { id: it.id, dx: step })}>→</button>
              <button title="Move up" onClick={() => call('PATCH', { id: it.id, dz: -step })}>↑</button>
              <button title="Move down" onClick={() => call('PATCH', { id: it.id, dz: step })}>↓</button>
              <button title="Turn 90°" onClick={() => call('PATCH', { id: it.id, turn: 90 })}>⟳</button>
              <button title="Remove" className="danger" onClick={() => call('PATCH', { id: it.id, remove: true })}>✕</button>
            </div>
          ) : <span className="muted small">Edit</span>}
        </div>))}
        {rows.length === 0 && <span className="muted">No furniture in this room.</span>}
      </div>
    </div>
  );
}
