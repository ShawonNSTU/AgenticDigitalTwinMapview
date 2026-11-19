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
  | { type: 'setLayer'; layer: 'devices' | 'piping' | 'names' | 'ids' | 'temperature'; on: boolean }
  | { type: 'setTime'; t: number }
  | { type: 'setScenario'; key: string }
  | { type: 'resetView' };

export type FromRenderer =
  | { type: 'ready'; version: string }
  | { type: 'deviceClicked'; id: string }
  | { type: 'partClicked'; id: string; part: string }
  | { type: 'deviceClosed' };

let frame: HTMLIFrameElement | null = null;
const queue: ToRenderer[] = [];
let ready = false;

export function attach(f: HTMLIFrameElement | null) { frame = f; }

export function send(msg: ToRenderer) {
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
