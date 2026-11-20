'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import types from '@/lib/sim/data/device_types.json';
import { send } from '@/lib/bridge';

type T = { label: string; iconSvg: string };
const TYPES = types as Record<string, T>;

/** Palette groups, in the order a facility team thinks about a floor. */
export const GROUPS: { name: string; types: string[] }[] = [
  { name: 'Climate', types: ['ac', 'odu', 'fan', 'purifier', 'temphum'] },
  { name: 'Light & shade', types: ['light', 'blinds'] },
  { name: 'Security', types: ['camera', 'motion', 'lock', 'doorbell', 'leak'] },
  { name: 'Appliances', types: ['fridge', 'oven', 'washer', 'dryer', 'vacuum'] },
  { name: 'Media & power', types: ['tv', 'speaker', 'plug'] },
];

/** Where each type is installed; shown on the tile and while dragging. */
export const MOUNT_HINT: Record<string, string> = {
  ac: 'wall', odu: 'outdoors', purifier: 'floor', temphum: 'wall', light: 'ceiling', blinds: 'window wall', camera: 'wall',
  motion: 'wall', lock: 'door', doorbell: 'door', leak: 'floor', fridge: 'floor', oven: 'floor', washer: 'floor', dryer: 'floor',
  vacuum: 'floor', tv: 'wall', speaker: 'floor', plug: 'wall', fan: 'floor',
};

export function DeviceIcon({ type, size = 22 }: { type: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: TYPES[type]?.iconSvg ?? '<circle cx="12" cy="12" r="8"/>' }} />;
}

type Drag = { type: string; x: number; y: number; over: boolean };
export type Hover = { roomName: string; valid: boolean; mount: string } | null;

/**
 * SmartThings device palette. Press on a tile and drag it onto the 3D map: while the pointer is over the map
 * the renderer shows the device snapped where it would be installed; release to place it. Works with mouse,
 * pen and touch (pointer events, with a transparent cover over the map so the iframe does not take the pointer).
 */
export default function DevicePalette({ stage, hover, counts }: { stage: React.RefObject<HTMLElement | null>; hover: Hover; counts: Record<string, number> }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [open, setOpen] = useState(true);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const uv = useCallback((x: number, y: number) => {
    const r = stage.current?.getBoundingClientRect();
    if (!r) return null;
    const u = (x - r.left) / r.width, v = (y - r.top) / r.height;
    return { u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
  }, [stage]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const p = uv(e.clientX, e.clientY);
      const over = !!p?.inside;
      if (over && !d.over) send({ type: 'dragStart', deviceType: d.type });
      if (over && p) send({ type: 'dragMove', u: p.u, v: p.v });
      if (!over && d.over && p) send({ type: 'dragEnd', u: p.u, v: p.v, drop: false });
      setDrag({ ...d, x: e.clientX, y: e.clientY, over });
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const p = uv(e.clientX, e.clientY);
      if (d.over && p) send({ type: 'dragEnd', u: p.u, v: p.v, drop: !!p.inside });
      setDrag(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const d = dragRef.current;
      if (d?.over) send({ type: 'dragEnd', u: 0, v: 0, drop: false });
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('keydown', key); };
  }, [drag?.type, uv]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (type: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDrag({ type, x: e.clientX, y: e.clientY, over: false });
  };

  return (
    <>
      <div className={`palette glass ${open ? '' : 'closed'}`}>
        <button className="palette-head" onClick={() => setOpen(!open)} title={open ? 'Hide the palette' : 'Show the palette'}>
          <span className="spark" /> <b>SmartThings devices</b><span className="chev">{open ? '‹' : '›'}</span>
        </button>
        {open && <div className="palette-body">
          <p className="hint">Drag a device onto a room</p>
          {GROUPS.map(g => (
            <div key={g.name} className="pal-group">
              <div className="pal-title">{g.name}</div>
              <div className="pal-grid">{g.types.map(t => (
                <div key={t} className={`tile ${drag?.type === t ? 'lifting' : ''}`} onPointerDown={begin(t)} title={`${TYPES[t].label} · ${MOUNT_HINT[t]}`} role="button" aria-label={`Drag ${TYPES[t].label} onto the map`}>
                  <DeviceIcon type={t} />
                  <span>{TYPES[t].label.replace('Temp. and humidity sensor', 'Temp & humidity').replace('Water leak sensor', 'Leak sensor')}</span>
                  {counts[t] ? <i className="count">{counts[t]}</i> : null}
                </div>))}
              </div>
            </div>))}
        </div>}
      </div>
      {drag && <div className="drag-cover" />}
      {drag && (
        <div className={`drag-chip ${drag.over ? (hover ? (hover.valid ? 'ok' : 'bad') : '') : ''}`} style={{ left: drag.x, top: drag.y }}>
          <DeviceIcon type={drag.type} size={18} />
          <span>{TYPES[drag.type].label}</span>
          {drag.over && hover && <em>{hover.valid ? `${hover.roomName} · ${hover.mount}` : hover.mount === 'outside the floor plan' ? 'Outside the floor plan' : `Can't go here`}</em>}
          {!drag.over && <em>{MOUNT_HINT[drag.type]} mount</em>}
        </div>
      )}
    </>
  );
}
