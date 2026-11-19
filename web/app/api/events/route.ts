import { floor, simState, tick } from '@/lib/sim/runtime';
import { LAYOUT } from '@/lib/sim/engine';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events: Server-Sent Events stream of the simulated device platform.
 * Emits `clock` every 500 ms, `health` whenever any device's health changes, and `layout` after a floor plan upload.
 * The Godot renderer (desktop build) and the web UI both subscribe to this.
 */
export async function GET() {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let last = '';
      let version = LAYOUT.version;
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const push = () => {
        tick();
        send('clock', simState());
        if (LAYOUT.version !== version) { version = LAYOUT.version; last = ''; send('layout', { version }); }
        const f = floor();
        const h = JSON.stringify(f.devices.map(d => [d.id, d.health]));
        if (h !== last) { last = h; send('health', f.devices.map(d => ({ id: d.id, health: d.health }))); }
      };
      push();
      timer = setInterval(push, 500);
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
