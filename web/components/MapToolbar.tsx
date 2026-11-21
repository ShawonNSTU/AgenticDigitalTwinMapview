'use client';
import { useEffect, useState } from 'react';
import { onRenderer, send } from '@/lib/bridge';

const LAYERS = [
  { key: 'piping', label: 'Piping' },
  { key: 'furniture', label: 'Interior' },
  { key: 'names', label: 'Device IDs' },
  { key: 'temperature', label: 'Health' },
  { key: 'comfort', label: 'Comfort' },
  { key: 'energy', label: 'Energy' },
] as const;
const TIERS = [['auto', 'Auto'], ['lite', 'Lite'], ['balanced', 'Balanced'], ['high', 'High'], ['ultra', 'Ultra']] as const;

/** Floating map controls: layers and view. */
export default function MapToolbar() {
  const [on, setOn] = useState<Record<string, boolean>>({ piping: true, furniture: true, names: false, temperature: false, comfort: false, energy: false });
  const [q, setQ] = useState<{ tier: string; auto: boolean; fps: number } | null>(null);
  // the renderer reports its quality tier (it adapts to the device's frame rate), and layers the assistant switched on
  useEffect(() => onRenderer(m => { if (m.type === 'quality') setQ({ tier: m.tier, auto: m.auto, fps: m.fps }); }), []);
  useEffect(() => { const f = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.layer) setOn(o => ({ ...o, [d.layer]: !!d.on })); }; window.addEventListener('twin-layer', f); return () => window.removeEventListener('twin-layer', f); }, []);
  // send() announces every layer switch (twin-layer), which sets the button state, from here or anywhere else
  const toggle = (k: (typeof LAYERS)[number]['key']) => send({ type: 'setLayer', layer: k, on: !on[k] });
  return (
    <div className="map-toolbar glass">
      {LAYERS.map(l => <button key={l.key} className={on[l.key] ? 'on' : ''} onClick={() => toggle(l.key)}>{l.label}</button>)}
      <span className="sep" />
      <select className="quality" aria-label="Rendering quality" title={q ? `${q.auto ? 'Adapts to this device' : 'Fixed'} · ${q.fps} fps` : 'Rendering quality'} value={q?.auto ? 'auto' : q?.tier ?? 'auto'} onChange={e => send({ type: 'setQuality', tier: e.target.value as 'auto' })}>
        {TIERS.map(([k, l]) => <option key={k} value={k}>{k === 'auto' && q?.auto ? `Auto · ${q.tier}` : l}</option>)}
      </select>
      <button onClick={() => send({ type: 'resetView' })} title="Back to the whole floor">Whole floor</button>
    </div>
  );
}
