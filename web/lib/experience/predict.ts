// "Fix it before the guest notices." Predicted failures, each with when, why and how sure:
//
//   degradation-model  a fault that is developing on a known curve (wear, clogging, a slow leak — the "Degrading"
//                      fault level): each affected component's health is weight × severity(t), so the time it crosses
//                      the watch (0.25) and fault (0.6) lines is computed exactly
//   scenario           the floor's scripted scenarios (blocked filter, refrigerant shortage) develop on the simulated
//                      clock; the time is converted with the clock's speed
//   trend              live readings, real or simulated: an AC that has been running for minutes without bringing the
//                      room toward its set point is losing capacity (filter, refrigerant, fan)
//   usage-model        batteries and filters wear at a typical rate per device type: days left from the level now
//
// Technicians can be dispatched to a device: the 3D view then draws the route from the lift lobby to it.
import { DEV, R, activeFault, byId, faultTimeline, sev, state as engineState, SCEN, TYPES } from '@/lib/sim/engine';
import { device, rt } from '@/lib/sim/runtime';
import { ARRIVAL } from '@/lib/sim/stzone';
import { defaultEntrance } from '@/lib/sim/guests';
import { assignee } from '@/lib/sim/maintenance';
import { log as journal } from '@/lib/kg/journal';
import { devName, num, round, roomName } from './geo';
import { roomComfort } from './comfort';

export type Prediction = {
  key: string; deviceId: string; name: string; type: string; room: string; roomName: string;
  part: string | null; partName: string | null; title: string; when: 'watch' | 'fault' | 'service';
  etaMin: number | null; etaText: string; at: number | null; confidence: number;
  basis: 'degradation-model' | 'scenario' | 'trend' | 'usage-model'; evidence: string[]; action: string;
};
export type Dispatch = { deviceId: string; tech: { id: string; name: string } | null; from: string; fromName: string; at: number; status: 'en_route' | 'on_site' | 'done'; reason: string };

const g = globalThis as unknown as { __predict?: { known: Record<string, number>; lagging: Record<string, number>; dispatches: Record<string, Dispatch>; version: number; list: Prediction[] } };
const P = (g.__predict ??= { known: {}, lagging: {}, dispatches: {}, version: 0, list: [] });
export const predictVersion = () => P.version;

const partName = (type: string, key: string) => (TYPES[type]?.parts ?? []).find((p: any) => p.key === key)?.name ?? key;
const fmt = (min: number) => min < 1 ? 'under a minute' : min < 90 ? `${Math.round(min)} min` : min < 48 * 60 ? `${round(min / 60, 1)} h` : `${Math.round(min / 1440)} days`;

// typical wear when nothing better is known (per day)
const BATTERY_DRAIN: Record<string, number> = { lock: 0.25, motion: 0.2, leak: 0.1, blinds: 0.35, doorbell: 0.3, temphum: 0.12, vacuum: 0 };

/** Every prediction now, soonest first. */
export function predictions(): Prediction[] {
  const now = Date.now();
  const out: Prediction[] = [];
  const base = (d: any) => ({ deviceId: d.id, name: devName(d.id), type: d.type, room: d.room, roomName: roomName(d.room) });

  for (const d of DEV as any[]) {
    // 1. a fault developing on a known curve
    const tl = faultTimeline(d.id), af = activeFault(d);
    if (tl && af && tl.rampMs >= 60_000) {
      for (const [part, w] of Object.entries(af.spec.parts as Record<string, number>)) {
        const k = w * tl.severity;
        if (k < 0.6) continue;                       // never reaches fault at this severity
        const tFault = tl.since + (0.6 / k) * tl.rampMs, tWatch = tl.since + (0.25 / k) * tl.rampMs;
        if (now >= tFault) continue;                 // already a fault: the alert covers it
        const s = af.s;
        out.push({
          key: `${d.id}|${part}|deg`, ...base(d), part, partName: partName(d.type, part), title: `${partName(d.type, part)} will fail: ${af.spec.name.toLowerCase()}`,
          when: 'fault', etaMin: round((tFault - now) / 60000, 1), etaText: fmt((tFault - now) / 60000), at: Math.round(tFault), confidence: 0.85, basis: 'degradation-model',
          evidence: [`${af.spec.what}`, `Wear at ${Math.round(s * 100)} % and rising ${round((tl.severity / (tl.rampMs / 60000)) * 100, 1)} %/min`, now < tWatch ? `Reaches watch level in ${fmt((tWatch - now) / 60000)}` : 'Already at watch level'],
          action: (af.spec.steps?.[0]?.t ?? 'Inspect the component') + ' before it fails',
        });
      }
    }
    // 2. usage models: batteries and filters
    let snap: any = null;
    try { snap = device(d.id); } catch { /* skip */ }
    const r = snap?.readings ?? {};
    const drain = BATTERY_DRAIN[d.type];
    if (drain && typeof r.batt === 'number' && r.batt <= 25) {
      const days = r.batt / drain;
      out.push({ key: `${d.id}|batt|use`, ...base(d), part: 'batt', partName: 'Battery', title: `Battery runs out in about ${Math.round(days)} days`, when: 'service', etaMin: round(days * 1440, 0), etaText: fmt(days * 1440), at: now + days * 86400_000, confidence: 0.6, basis: 'usage-model', evidence: [`Battery at ${r.batt} %`, `Typical drain for a ${TYPES[d.type].label.toLowerCase()}: ${drain} %/day`], action: 'Replace the battery on the next round' });
    }
    if (d.type === 'purifier' && typeof r.hepa === 'number' && r.hepa <= 25) {
      const days = r.hepa / 0.5;
      out.push({ key: `${d.id}|hepa|use`, ...base(d), part: 'hepa', partName: 'HEPA filter', title: 'HEPA filter due for replacement', when: 'service', etaMin: round(days * 1440, 0), etaText: fmt(days * 1440), at: now + days * 86400_000, confidence: 0.6, basis: 'usage-model', evidence: [`Filter life ${r.hepa} %`, 'Typical use: 0.5 %/day'], action: 'Order and fit a new HEPA filter' });
    }
    // 3. trend: an AC running without bringing the room toward its set point
    if (d.type === 'ac' && r.on !== false && (r.mode ?? 'cool') === 'cool' && num(r.room, 0) - num(r.set, 99) > 1.5) {
      const c = roomComfort(d.room);
      const slope = c?.trend ?? null;
      if (slope != null && slope > -0.02) {
        P.lagging[d.id] ??= now;
        const mins = (now - P.lagging[d.id]) / 60000;
        if (mins >= 3) out.push({ key: `${d.id}|cap|trend`, ...base(d), part: 'coil', partName: partName(d.type, 'coil'), title: 'Cooling not keeping up: capacity is dropping', when: 'watch', etaMin: null, etaText: 'now', at: null, confidence: 0.7, basis: 'trend', evidence: [`Room ${round(num(r.room, 0), 1)} °C, set ${r.set} °C for ${Math.round(mins)} min`, `Temperature trend ${slope >= 0 ? '+' : ''}${slope} °C/min (a working unit pulls it down)`, 'Usual causes: clogged filter, low refrigerant, a weak fan'], action: 'Check the filter and the airflow first' });
      } else delete P.lagging[d.id];
    } else delete P.lagging[d.id];
  }

  // 4. the floor's scripted scenarios, on the simulated clock
  const s0 = SCEN[engineState.scen];
  if (s0?.onset != null && engineState.fixT == null) {
    const at = (level: number) => s0.onset + level * s0.ramp;
    const real = (simH: number) => rt.playing && rt.speed > 0 ? (simH * 3600) / rt.speed / 60 : null;
    const add = (id: string | null, part: string, level: number, title: string, evidence: string[], action: string) => {
      if (!id || !byId[id] || sev(rt.t) >= level) return;
      const simH = at(level) - rt.t, d = byId[id];
      const m = real(simH);
      out.push({ key: `${id}|${part}|scen`, ...base(d), part, partName: partName(d.type, part), title, when: 'fault', etaMin: m == null ? null : round(m, 1), etaText: m == null ? `at ${String(Math.floor(at(level))).padStart(2, '0')}:${String(Math.round((at(level) % 1) * 60)).padStart(2, '0')} on the floor clock` : fmt(m), at: m == null ? null : now + m * 60000, confidence: 0.75, basis: 'scenario', evidence, action });
    };
    if (engineState.scen === 'filter') add(R.filterAc, 'filter', 0.3, 'Air filter will block the airflow', ['Airflow trending down while the fan speeds up', 'Coil inlet temperature falling toward freezing'], 'Clean the air filter');
    if (engineState.scen === 'refrig') add(R.odu, 'comp', 0.35, 'Refrigerant shortage will overheat the compressor', ['Discharge temperature rising', 'Low-side pressure falling'], 'Leak-test the circuit to the far rooms');
  }

  out.sort((a, b) => (a.etaMin ?? 1e9) - (b.etaMin ?? 1e9) || b.confidence - a.confidence);
  return out;
}

/** Periodic step: notice new predictions due soon (into the journal; the event stream tells technicians). */
export function tick() {
  const list = predictions();
  const now = Date.now();
  const keys = new Set(list.map(p => p.key));
  let changed = list.length !== P.list.length;
  for (const p of list) {
    if (!(p.key in P.known)) {
      P.known[p.key] = now; changed = true;
      if (p.etaMin != null && p.etaMin <= 60 || p.basis === 'trend') journal({ kind: 'prediction', devices: [p.deviceId], room: p.room, text: `Predicted: ${p.name} (${p.deviceId}) in ${p.roomName}: ${p.title}${p.etaMin != null ? `, in about ${p.etaText}` : ''} (${p.basis}, confidence ${Math.round(p.confidence * 100)} %)` });
    }
  }
  for (const k of Object.keys(P.known)) if (!keys.has(k)) { delete P.known[k]; changed = true; }
  P.list = list;
  for (const [id, d] of Object.entries(P.dispatches)) if (d.status !== 'done' && byId[id] && !list.some(p => p.deviceId === id) && !activeFault(byId[id])) { d.status = 'done'; changed = true; }
  if (changed) P.version++;
}
export const latest = () => P.list;

/** Send a technician to a device: who, from where (the lift lobby or the floor's entrance), and why. */
export function dispatchTech(deviceId: string, reason = '') {
  const d = byId[deviceId];
  if (!d) return null;
  const from = ARRIVAL.key || defaultEntrance() || '';
  const t = assignee(d.type, d.room);
  const x: Dispatch = { deviceId, tech: t ? { id: t.id, name: t.name } : null, from, fromName: from ? roomName(from) : 'Entrance', at: Date.now(), status: 'en_route', reason: reason || P.list.find(p => p.deviceId === deviceId)?.title || 'Inspection' };
  P.dispatches[deviceId] = x; P.version++;
  journal({ kind: 'maintenance', devices: [deviceId], room: d.room, by: t?.name, text: `${t?.name ?? 'A technician'} dispatched to ${devName(deviceId)} (${deviceId}) in ${roomName(d.room)} from ${x.fromName}: ${x.reason}` });
  return x;
}
export function setDispatch(deviceId: string, status: Dispatch['status']) {
  const x = P.dispatches[deviceId];
  if (!x) return null;
  x.status = status; P.version++;
  journal({ kind: 'maintenance', devices: [deviceId], room: byId[deviceId]?.room, text: `${x.tech?.name ?? 'Technician'} ${status === 'on_site' ? 'arrived at' : status === 'done' ? 'finished at' : 'on the way to'} ${devName(deviceId)} (${deviceId})` });
  return x;
}
export const dispatches = () => Object.values(P.dispatches).filter(x => x.status !== 'done' || Date.now() - x.at < 3600_000);
