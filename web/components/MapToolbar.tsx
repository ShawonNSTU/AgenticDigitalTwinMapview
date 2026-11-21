'use client';
import { useState } from 'react';
import { send } from '@/lib/bridge';

const LAYERS = [
  { key: 'piping', label: 'Piping' },
  { key: 'furniture', label: 'Interior' },
  { key: 'names', label: 'Device IDs' },
  { key: 'temperature', label: 'Heat map' },
] as const;

/** Floating map controls: layers and view. */
export default function MapToolbar() {
  const [on, setOn] = useState<Record<string, boolean>>({ piping: true, furniture: true, names: false, temperature: false });
  const toggle = (k: (typeof LAYERS)[number]['key']) => { const v = !on[k]; setOn({ ...on, [k]: v }); send({ type: 'setLayer', layer: k, on: v }); };
  return (
    <div className="map-toolbar glass">
      {LAYERS.map(l => <button key={l.key} className={on[l.key] ? 'on' : ''} onClick={() => toggle(l.key)}>{l.label}</button>)}
      <span className="sep" />
      <button onClick={() => send({ type: 'resetView' })} title="Back to the whole floor">Whole floor</button>
    </div>
  );
}
