'use client';
import { useEffect, useState } from 'react';
import { onRenderer, send } from '@/lib/bridge';

const I = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />;
type CamAction = 'zoomIn' | 'zoomOut' | 'fit' | 'top' | 'perspective' | 'rotateLeft' | 'rotateRight' | 'tiltUp' | 'tiltDown' | 'north';
const cam = (action: CamAction) => send({ type: 'camera', action });

/** Map navigation: zoom, fit the whole floor, plan (2D) or 3D view, rotate, and the keyboard shortcuts. */
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
        <button title="Rotate left (Q)" aria-label="Rotate left" onClick={() => cam('rotateLeft')}><I d='<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>' /></button>
        <button title="Rotate right (E)" aria-label="Rotate right" onClick={() => cam('rotateRight')}><I d='<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>' /></button>
        <button title="Tilt: look more from above (R)" aria-label="Tilt up" onClick={() => cam('tiltDown')}><I d='<path d="M6 15l6-6 6 6"/>' /></button>
        <button title="Tilt: look more from the side (V)" aria-label="Tilt down" onClick={() => cam('tiltUp')}><I d='<path d="M6 9l6 6 6-6"/>' /></button>
      </div>
      <div className="nav-group glass">
        <button className={keys ? 'on' : ''} title="Mouse and keyboard controls" aria-label="Controls" onClick={() => setKeys(!keys)}><b>?</b></button>
      </div>
      {keys && (
        <div className="nav-help glass">
          <b>Navigate the map</b>
          <dl>
            <dt>Orbit</dt><dd>Left-drag in any direction (sideways turns, up/down tilts)</dd>
            <dt>Turn / tilt</dt><dd>Q / E, R / V, or the buttons; trackpad: swipe sideways, Shift + scroll</dd>
            <dt>Pan</dt><dd>Right-drag, Shift + drag, or arrow keys / WASD</dd>
            <dt>Zoom</dt><dd>Wheel or trackpad scroll (toward the cursor), pinch, or + / −</dd>
            <dt>Touch</dt><dd>One finger orbits; two fingers pinch, pan and twist; double tap zooms in</dd>
            <dt>Zoom to a spot</dt><dd>Double-click the floor</dd>
            <dt>Whole floor</dt><dd>F</dd>
            <dt>Plan view</dt><dd>T</dd>
          </dl>
          <span className="muted">Click the map first so it receives keys.</span>
        </div>
      )}
    </div>
  );
}
