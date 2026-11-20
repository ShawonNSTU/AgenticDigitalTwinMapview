'use client';
import { useState } from 'react';
import { send } from '@/lib/bridge';

const I = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />;
type CamAction = 'zoomIn' | 'zoomOut' | 'fit' | 'top' | 'perspective' | 'rotateLeft' | 'rotateRight';
const cam = (action: CamAction) => send({ type: 'camera', action });

/** Map navigation: zoom, fit the whole floor, plan (2D) or 3D view, rotate, and the keyboard shortcuts. */
export default function MapNav() {
  const [top, setTop] = useState(false);
  const [keys, setKeys] = useState(false);
  return (
    <div className="map-nav">
      <div className="nav-group glass">
        <button title="Zoom in (+ or wheel)" aria-label="Zoom in" onClick={() => cam('zoomIn')}><I d='<path d="M12 5v14M5 12h14"/>' /></button>
        <button title="Zoom out (− or wheel)" aria-label="Zoom out" onClick={() => cam('zoomOut')}><I d='<path d="M5 12h14"/>' /></button>
      </div>
      <div className="nav-group glass">
        <button title="Fit the whole floor (F)" aria-label="Fit the whole floor" onClick={() => cam('fit')}><I d='<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' /></button>
        <button className={top ? 'on' : ''} title={top ? 'Back to the 3D view (T)' : 'Plan view from above (T)'} aria-label="Toggle plan view" onClick={() => { cam(top ? 'perspective' : 'top'); setTop(!top); }}><b>{top ? '3D' : '2D'}</b></button>
      </div>
      <div className="nav-group glass">
        <button title="Rotate left (Q)" aria-label="Rotate left" onClick={() => cam('rotateLeft')}><I d='<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>' /></button>
        <button title="Rotate right (E)" aria-label="Rotate right" onClick={() => cam('rotateRight')}><I d='<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>' /></button>
      </div>
      <div className="nav-group glass">
        <button className={keys ? 'on' : ''} title="Mouse and keyboard controls" aria-label="Controls" onClick={() => setKeys(!keys)}><b>?</b></button>
      </div>
      {keys && (
        <div className="nav-help glass">
          <b>Navigate the map</b>
          <dl>
            <dt>Rotate</dt><dd>Left-drag, or Q / E</dd>
            <dt>Pan</dt><dd>Right-drag, Shift + drag, or arrow keys / WASD</dd>
            <dt>Zoom</dt><dd>Wheel (toward the cursor), pinch, or + / −</dd>
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
