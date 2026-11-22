// The experience services' heartbeat: every 2 s it samples energy, refreshes comfort, advances guest journeys and
// re-checks predictions. One timer per server process (kept on globalThis so a hot reload doesn't start a second).
// `snapshot()` is what rides along with every /api/floor poll for the 3D view (per-room comfort with its field
// sources, live watts, journeys and predictions); a guest's poll gets only their own room.
import { DEV } from '@/lib/sim/engine';
import { onActivity } from '@/lib/sim/dispatch';
import * as energy from './energy';
import { comfortField } from './comfort';
import * as arrival from './arrival';
import * as predict from './predict';

const PERIOD_MS = 2000;
const g = globalThis as unknown as { __xp?: { timer: ReturnType<typeof setInterval> | null; busy: boolean; field: ReturnType<typeof comfortField>; at: number; gen: number } };
const X = (g.__xp ??= { timer: null, busy: false, field: {}, at: 0, gen: 0 });
const GEN = Date.now();   // this module instance (a hot reload replaces the timer with one running the new code)

async function step() {
  if (X.busy) return;
  X.busy = true;
  try {
    try { energy.sample(); } catch (e) { console.error('[experience] energy', e); }
    try { X.field = comfortField(); X.at = Date.now(); } catch (e) { console.error('[experience] comfort', e); }
    try { await arrival.tick(); } catch (e) { console.error('[experience] arrival', e); }
    try { predict.tick(); } catch (e) { console.error('[experience] predict', e); }
  } finally { X.busy = false; }
}

export function ensureExperience() {
  if (X.timer && X.gen === GEN) return;
  if (X.timer) clearInterval(X.timer);
  X.gen = GEN;
  X.timer = setInterval(() => { void step(); }, PERIOD_MS);
  (X.timer as any).unref?.();
  // someone used a room the automation holds in eco: eco ends there
  onActivity((room, _id, by) => { if (energy.ecoRooms().includes(room)) energy.endEco(room, `${by} changed a device`); });
  void step();
}

/** Run one step now (tests, and APIs that need fresh numbers). */
export const refresh = step;

/** Versions the event stream watches to tell pages something changed. */
export const versions = () => ({ arrival: arrival.arrivalVersion(), predict: predict.predictVersion() });

/** What the 3D view needs with each poll. Staff: the whole floor; a guest: their room only. */
export function snapshot(room?: string) {
  ensureExperience();
  const ids = room ? new Set((DEV as any[]).filter(d => d.room === room).map(d => d.id)) : undefined;
  const field = room ? Object.fromEntries(Object.entries(X.field).filter(([k]) => k === room)) : X.field;
  const watts = energy.liveWatts(ids);
  const eco = energy.ecoRooms().filter(r => !room || r === room);
  const js = arrival.journeys().filter(j => !room || j.room === room).map(j => ({ room: j.room, state: j.state, guest: room ? j.guest : j.guest ? j.guest.split(' ')[0] : '', eta: j.eta, readyAt: j.readyAt }));
  const preds = room ? [] : predict.latest().map(p => ({ id: p.deviceId, part: p.part, when: p.when, etaMin: p.etaMin, title: p.title }));
  const disp = room ? [] : predict.dispatches().filter(d => d.status !== 'done').map(d => ({ id: d.deviceId, from: d.from, status: d.status }));
  return { comfort: field, watts, eco, journeys: js, predictions: preds, dispatches: disp };
}
