'use client';
import { useEffect, useRef, useState } from 'react';
import { attach, onRenderer, type FromRenderer } from '@/lib/bridge';

/** Hosts the Godot web export (public/godot/index.html) and wires the message bridge. */
export default function TwinView({ onEvent }: { onEvent: (m: FromRenderer) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => { fetch('/godot/index.html', { method: 'HEAD' }).then(r => setPresent(r.ok)).catch(() => setPresent(false)); }, []);
  useEffect(() => { attach(ref.current); return onRenderer(onEvent); }, [onEvent, present]);
  if (present === false) return (
    <div className="twin-empty">
      <b>Godot renderer not exported yet</b>
      <p>Export <code>godot-renderer</code> with the &quot;Web&quot; preset into <code>web/public/godot/</code>, then reload. The panels, search and chat already work against the simulated devices.</p>
    </div>
  );
  return <iframe ref={ref} className="twin" src="/godot/index.html" title="3D map view" allow="fullscreen" />;
}
