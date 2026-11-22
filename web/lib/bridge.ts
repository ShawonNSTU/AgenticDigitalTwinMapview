// Typed messages between this page and the Godot renderer running in an iframe.
// Full contract: docs/contracts/bridge-api.md

export type ToRenderer =
  | { type: 'highlight'; ids: string[]; reason?: string }
  | { type: 'clearHighlight' }
  | { type: 'focusDevice'; id: string }
  | { type: 'openDevice'; id: string; part?: string }
  | { type: 'closeDevice' }
  | { type: 'focusPart'; id: string; part: string }
  | { type: 'trace'; from: string }
  | { type: 'setLayer'; layer: 'devices' | 'piping' | 'names' | 'ids' | 'temperature' | 'exploded' | 'furniture' | 'comfort' | 'energy' | 'ops'; on: boolean; metric?: 'thermal' | 'air' | 'score' }
  | { type: 'setTime'; t: number }
  | { type: 'setScenario'; key: string }
  | { type: 'resetView' }
  | { type: 'setInsets'; left: number; right: number; top: number; bottom: number }
  | { type: 'camera'; action: 'zoomIn' | 'zoomOut' | 'fit' | 'top' | 'perspective' | 'toggleTop' | 'rotateLeft' | 'rotateRight' | 'tiltUp' | 'tiltDown' | 'north' | 'reset' }
  | { type: 'dragStart'; deviceType: string }
  | { type: 'dragMove'; u: number; v: number }
  | { type: 'dragEnd'; u: number; v: number; drop: boolean }
  | { type: 'startMove'; id: string }
  | { type: 'refreshDevices' }
  | { type: 'walk'; action: 'start' | 'stop' | 'toggle' | 'goto' | 'stick' | 'skip' | 'restart' | 'overview' | 'look' | 'show' | 'live' | 'stepFree'; room?: string; x?: number; y?: number; from?: string; on?: boolean; id?: string }
  | { type: 'selectRoom'; room: string }
  // guest 3D controls: show a value in the room while it is being dragged, and report a device's screen position
  | { type: 'preview'; id: string; readings: Record<string, unknown>; text?: string }
  | { type: 'track'; id: string }
  // story mode (app/story): cinematic shots, data wave, guest/technician walks, TV text, heatmap, night
  // experience: rendering quality, a technician's route to a device, a guest's welcome moment
  | { type: 'setQuality'; tier: 'auto' | 'ultra' | 'high' | 'balanced' | 'lite' }
  | { type: 'dispatchRoute'; id: string }
  | { type: 'daylight'; hour?: number | null }   // show the light of this local hour (0-24); null: the real time
  | { type: 'welcome'; room: string; guest?: string; state?: string }
  | { type: 'story'; action: 'build' | 'shot' | 'room' | 'wave' | 'walk' | 'endWalk' | 'tv' | 'heat' | 'night' | 'cast'; [k: string]: unknown };

/** Where the renderer put a dropped or moved device (metres; rotationY 0 faces +z). */
export type Placement = { x: number; y: number; z: number; rotationY: number; room: string };

export type FromRenderer =
  | { type: 'ready'; version: string; view?: [number, number] }
  | { type: 'viewport'; view: [number, number] }
  | { type: 'floorBuilt'; rooms: number; devices: number }
  | { type: 'camera'; yaw: number; pitch: number; distance: number; top: boolean }
  | { type: 'deviceClicked'; id: string }
  | { type: 'partClicked'; id: string; part: string }
  | { type: 'deviceClosed' }
  | ({ type: 'dropDevice'; deviceType: string } & Placement)
  | ({ type: 'moveDevice'; id: string } & Placement)
  | { type: 'placeHover'; room: string; roomName: string; valid: boolean; mount: string }
  | { type: 'walk'; on: boolean; room?: string; roomName?: string; note?: string; guest?: 'walking' | 'arrived'; from?: string; to?: string; metres?: number; route?: [number, number][]; viewing?: string; live?: { x: number; z: number; room: string; toRoom?: number; atDoor?: boolean } }
  | { type: 'roomClicked'; room: string; roomName: string }
  | { type: 'guestDenied'; code: number }
  | { type: 'anchor'; id: string; x: number; y: number; visible: boolean }
  | { type: 'quality'; tier: string; auto: boolean; fps: number; scale: number; renderer: string }
  | { type: 'techRoute'; id: string; metres: number; from: string; phase: 'started' | 'arrived' | 'failed' };

/** The renderer build this page expects (godot-renderer/autoloads/bridge.gd VERSION). An older export in
 *  web/public/godot is reported on the page, so a stale build is never mistaken for a bug. */
export const RENDERER_VERSION = '0.8.0';

let frame: HTMLIFrameElement | null = null;
const queue: ToRenderer[] = [];
let ready = false;

export function attach(f: HTMLIFrameElement | null) { frame = f; }

export function send(msg: ToRenderer) {
  // layer switches from anywhere (a panel, the assistant) keep the map toolbar's buttons in step
  if (msg.type === 'setLayer' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('twin-layer', { detail: msg }));
  if (!ready || !frame?.contentWindow) { queue.push(msg); return; }
  frame.contentWindow.postMessage({ source: 'twin-host', ...msg }, '*');
}

export function onRenderer(handler: (m: FromRenderer) => void) {
  const fn = (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.source !== 'twin-renderer') return;
    if (d.type === 'ready') { ready = true; queue.splice(0).forEach(send); }
    handler(d as FromRenderer);
  };
  window.addEventListener('message', fn);
  return () => window.removeEventListener('message', fn);
}
