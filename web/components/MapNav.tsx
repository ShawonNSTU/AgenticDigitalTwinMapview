'use client';
import { useEffect, useState } from 'react';
import { onRenderer, send } from '@/lib/bridge';
import FullscreenButton from './FullscreenButton';

const I = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />;
type CamAction = 'zoomIn' | 'zoomOut' | 'fit' | 'top' | 'perspective' | 'rotateLeft' | 'rotateRight' | 'tiltUp' | 'tiltDown' | 'north';
const cam = (action: CamAction) => send({ type: 'camera', action });

/** Map navigation: north, zoom, fit the whole floor, plan (2D) or 3D view, walk, full screen, help. Turning and tilting
 *  are done by dragging (Q/E, R/V on the keyboard). */
export default function MapNav() {
  const [top, setTop] = useState(false);
  const [keys, setKeys] = useState(false);
  const [yaw, setYaw] = useState(0);
  // follow the camera: the compass turns with the view and the 2D/3D toggle matches what is shown
  useEffect(() => onRenderer(m => { if (m.type === 'camera') { setYaw(m.yaw); setTop(m.top); } }), []);
  return (
    <div className="map-nav">
      <div className="nav-group glass">
        <button className="compass" title="North up (click to face north)" aria-label="Face north" onClick={() => cam('north')}>
          <svg width="20" height="20" viewBox="0 0 24 24" style={{ transform: `rotate(${yaw}deg)` }}><path d="M12 3l3.5 9h-7z" fill="#dc2626" /><path d="M12 21l-3.5-9h7z" fill="#94a3b8" /></svg>
        </button>
      </div>
      <div className="nav-group glass">
        <button title="Zoom in (+ or wheel)" aria-label="Zoom in" onClick={() => cam('zoomIn')}><I d='<path d="M12 5v14M5 12h14"/>' /></button>
        <button title="Zoom out (− or wheel)" aria-label="Zoom out" onClick={() => cam('zoomOut')}><I d='<path d="M5 12h14"/>' /></button>
      </div>
      <div className="nav-group glass">
        <button title="Fit the whole floor (F)" aria-label="Fit the whole floor" onClick={() => cam('fit')}><I d='<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' /></button>
        <button className={top ? 'on' : ''} title={top ? 'Back to the 3D view (T)' : 'Plan view from above (T)'} aria-label="Toggle plan view" onClick={() => cam(top ? 'perspective' : 'top')}><b>{top ? '3D' : '2D'}</b></button>
      </div>
      <div className="nav-group glass">
        <button className="walk-btn" title="Walk through the floor at eye height (enter rooms through their doors)" aria-label="Walk through" onClick={() => send({ type: 'walk', action: 'start' })}>
          <I d='<circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 3 3M11 15l1-6"/>' />
        </button>
        <FullscreenButton className="" />
        <button className={keys ? 'on' : ''} title="Mouse and keyboard controls" aria-label="Controls" onClick={() => setKeys(!keys)}><b>?</b></button>
      </div>
      {keys && (
        <div className="nav-help glass">
          <b>Navigate the map</b>
          <dl>
            <dt>Turn and tilt</dt><dd>Drag (one finger on touch)</dd>
            <dt>Move</dt><dd>Right-drag or two fingers</dd>
            <dt>Zoom</dt><dd>Scroll or pinch</dd>
            <dt>Keys</dt><dd>Q / E turn · R / V tilt · F whole floor · T plan view</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
