import { floor, simState, tick } from '@/lib/sim/runtime';
import { LAYOUT } from '@/lib/sim/engine';
import { alerts } from '@/lib/sim/maintenance';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events: Server-Sent Events stream of the simulated device platform.
 * Emits `clock` every 500 ms, `alert` when a device raises a new alert (technicians are notified), `health` whenever any device's health changes, `layout` after a floor plan upload and `devices` when devices are placed, moved or removed.
 * The Godot renderer (desktop build) and the web UI both subscribe to this.
 */
export async function GET() {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let last = '';
      let version = LAYOUT.version;
      let devVersion = LAYOUT.devVersion;
      let known = new Set(alerts().map(a => a.key)); // alerts already open when the page connected
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const push = () => {
        tick();
        send('clock', simState());
        if (LAYOUT.version !== version) { version = LAYOUT.version; devVersion = LAYOUT.devVersion; last = ''; send('layout', { version }); }
        else if (LAYOUT.devVersion !== devVersion) { devVersion = LAYOUT.devVersion; last = ''; send('devices', { version: devVersion }); }
        const f = floor();
        const h = JSON.stringify(f.devices.map(d => [d.id, d.health, (d as { fault?: string }).fault ?? '']));
        if (h !== last) {
          last = h; send('health', f.devices.map(d => ({ id: d.id, health: d.health, fault: (d as { fault?: string }).fault ?? null })));
          const now = alerts();
          for (const a of now) if (!known.has(a.key)) send('alert', { key: a.key, deviceId: a.deviceId, label: a.label, roomName: a.roomName, level: a.level, title: a.title, assignee: a.assignee });
          known = new Set(now.map(a => a.key));
        }
      };
      push();
      timer = setInterval(push, 500);
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
