'use client';
import { useEffect, useRef, useState } from 'react';
import { attach, onRenderer, type FromRenderer } from '@/lib/bridge';

/** Hosts the Godot web export (public/godot/index.html) and wires the message bridge. */
export default function TwinView({ onEvent, ready = false }: { onEvent: (m: FromRenderer) => void; ready?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => { fetch('/godot/index.html', { method: 'HEAD' }).then(r => setPresent(r.ok)).catch(() => setPresent(false)); }, []);
  useEffect(() => { attach(ref.current); return onRenderer(onEvent); }, [onEvent, present]);
  // a renderer that has not said "ready" after 45 s is stuck (no WebGL 2, blocked download, out of memory)
  const [slow, setSlow] = useState(false);
  useEffect(() => { if (ready) return; const h = setTimeout(() => setSlow(true), 45000); return () => clearTimeout(h); }, [ready]);
  if (present === false) return (
    <div className="twin-empty">
      <b>Godot renderer not exported yet</b>
      <p>Export <code>godot-renderer</code> with the &quot;Web&quot; preset into <code>web/public/godot/</code>, then reload. The panels, search and chat already work against the simulated devices.</p>
    </div>
  );
  return (
    <>
      <iframe ref={ref} className="twin" src="/godot/index.html" title="3D map view" allow="fullscreen" />
      {present && !ready && (
        <div className="loading" role="status">
          <span className="spinner" aria-hidden />
          <b>{slow ? 'The 3D view is taking longer than usual' : 'Loading the 3D map'}</b>
          <span className="muted">{slow ? 'It needs WebGL 2 and about 40 MB on first load. Try reloading, or a desktop browser with hardware acceleration on.' : 'Preparing the floor, interiors and devices…'}</span>
        </div>
      )}
    </>
  );
}
