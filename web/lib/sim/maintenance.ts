// Technician side: alerts raised by devices that are not healthy, and the records technicians keep while they
// investigate. An alert carries where the device is, what it reports, its recent events, the troubleshooting
// guidance from the diagnosis and the open/acknowledged/investigating/resolved status from the records.
import { randomBytes } from 'node:crypto';
import { DEV, ROOMS, TYPES, activeFault, FAULT_DOCS, clearFault, R, state as engineState } from './engine';
import { device, rt, tick, setSim } from './runtime';
import { log as journal } from '@/lib/kg/journal';

export type Status = 'new' | 'acknowledged' | 'investigating' | 'resolved';
export type Record_ = { id: string; deviceId: string; at: number; by: string; status: Exclude<Status, 'new'>; cause: string; action: string; notes: string; alert: string };

type Seen = { since: number; title: string; level: string };
/** Who an alert goes to: each technician covers device types (and optionally only some rooms). */
export type Tech = { id: string; name: string; types: string[]; rooms: string[] };
const gt = globalThis as unknown as { __techs?: Tech[] };
const techs: Tech[] = (gt.__techs ??= [
  { id: 'hvac', name: 'HVAC technician', types: ['ac', 'odu', 'fan', 'purifier', 'fridge', 'temphum'], rooms: [] },
  { id: 'elec', name: 'Electrical & IT technician', types: ['light', 'tv', 'plug', 'blinds', 'lock', 'camera', 'motion', 'doorbell', 'speaker', 'vacuum', 'washer', 'dryer', 'oven', 'leak'], rooms: [] },
]);
export const technicians = () => techs;
export function setTechnicians(list: Tech[]) { techs.splice(0, techs.length, ...list); return techs; }
export const assignee = (type: string, room: string) => techs.find(t => t.types.includes(type) && (!t.rooms.length || t.rooms.includes(room))) ?? null;

const g = globalThis as unknown as { __maint?: Record_[]; __seen?: Record<string, Seen>; __events?: Record<string, { at: number; text: string }[]> };
const records: Record_[] = (g.__maint ??= []);
const seen: Record<string, Seen> = (g.__seen ??= {});
const events: Record<string, { at: number; text: string }[]> = (g.__events ??= {});

const roomName = (key: string) => { const r = ROOMS.find((x: any) => x.key === key) as any; return r ? String(r.label ?? r.name).split('\n')[0] : 'Outside'; };
const note = (id: string, text: string) => { (events[id] ??= []).push({ at: Date.now(), text }); if (events[id].length > 30) events[id].shift(); };

/** Alerts for every device that is not healthy now (and keeps when each started, for "since"). */
export function alerts() {
  tick();
  const out = [];
  const live = new Set<string>();
  for (const d of DEV as any[]) {
    const s = device(d.id);
    if (!s || s.health === 'ok') continue;
    const fault0 = activeFault(d);
    // a device-level diagnosis if there is one, else what the active fault itself says
    const f: any = s.finding ?? (fault0 ? { title: fault0.spec.title, conf: fault0.spec.conf, ev: fault0.spec.ev(s.readings, fault0.s), steps: fault0.spec.steps } : null);
    const title = f?.title ?? `${TYPES[d.type].label} needs attention`;
    const key = `${d.id}|${title}`;
    live.add(key);
    if (!seen[key]) { seen[key] = { since: Date.now(), title, level: s.health }; note(d.id, `Alert raised: ${title}`); journal({ kind: 'alert', devices: [d.id], room: d.room, text: `Alert raised on ${String(d.name).split(' · ')[0]} (${d.id}): ${title} (${s.health})` }); }
    const recs = records.filter(r => r.deviceId === d.id && r.at >= seen[key].since).sort((a, b) => b.at - a.at);
    const fault = activeFault(d);
    out.push({
      key, deviceId: d.id, type: d.type, label: TYPES[d.type].label, name: String(d.name).split(' · ')[0],
      room: d.room, roomName: roomName(d.room), position: d.p,
      level: s.health, title, since: seen[key].since, online: (s as any).online !== false,
      reported: f?.ev ?? [], confidence: f?.conf ?? '', steps: f?.steps ?? [],
      parts: s.parts.filter((p: any) => p.health !== 'ok').map((p: any) => ({ key: p.key, name: p.name, value: p.value, health: p.health, inferred: p.inferred })),
      docs: FAULT_DOCS(d.type, fault?.spec.key),
      simulated: !!fault,
      assignee: (() => { const t = assignee(d.type, d.room); return t ? { id: t.id, name: t.name } : null; })(),
      status: (recs[0]?.status ?? 'new') as Status,
      events: [...(events[d.id] ?? []), ...rt.log.filter(l => l.deviceId === d.id).slice(-5).map(l => ({ at: 0, text: `Command ${l.command} by ${l.by} at ${String(Math.floor(l.at)).padStart(2, '0')}:${String(Math.round((l.at % 1) * 60)).padStart(2, '0')}` }))].slice(-8),
    });
  }
  for (const k of Object.keys(seen)) if (!live.has(k)) { note(k.split('|')[0], `Back to normal: ${seen[k].title}`); journal({ kind: 'alert', devices: [k.split('|')[0]], text: `Back to normal: ${k.split('|')[0]} (${seen[k].title})` }); delete seen[k]; }
  const rank = { fault: 0, watch: 1 } as Record<string, number>;
  return out.sort((a, b) => (rank[a.level] - rank[b.level]) || (b.since - a.since));
}

/**
 * A technician resolved the problem: make the device actually healthy, so every view (admin list and 3D view, the
 * technician console, the guest page, the assistant) shows it fixed within a second, with no manual clearing.
 *   - a simulated fault on the device (technician console, story, assistant) is cleared;
 *   - a scenario problem it belongs to (clogged filter, refrigerant, washer drain and the leak beside it) gets the
 *     scenario's "fixed" point, so its readings recover;
 *   - a low battery counts as replaced.
 * A real SmartThings device's own state (e.g. offline) is what the device reports: that clears when it reports again.
 * Returns what was done.
 */
export function fixDevice(id: string): string[] {
  const done: string[] = [];
  if (activeFault((DEV as any[]).find(d => d.id === id))) { clearFault(id); done.push('fault cleared'); }
  const inScenario = (engineState.scen === 'filter' && R.filterAc === id) || (engineState.scen === 'refrig' && (R.odu === id || R.far.includes(id)))
    || (engineState.scen === 'washer' && (R.washer === id || R.leak === id));
  if (inScenario && engineState.fixT == null) { setSim({ fix: true }); done.push('scenario repaired'); }
  if (R.lowBatt === id) { R.lowBatt = null; done.push('battery replaced'); }
  return done;
}

export function addRecord(p: { deviceId: string; status: Exclude<Status, 'new'>; cause?: string; action?: string; notes?: string; by?: string; alert?: string }) {
  if (!DEV.some((d: any) => d.id === p.deviceId)) throw new Error(`Unknown device ${p.deviceId}`);
  const r: Record_ = { id: randomBytes(6).toString('hex'), deviceId: p.deviceId, at: Date.now(), by: (p.by ?? 'Technician').slice(0, 40), status: p.status,
    cause: (p.cause ?? '').slice(0, 300), action: (p.action ?? '').slice(0, 300), notes: (p.notes ?? '').slice(0, 1000), alert: (p.alert ?? '').slice(0, 160) };
  records.push(r);
  // resolved = fixed: the device goes back to normal everywhere (see fixDevice)
  const fixed = p.status === 'resolved' ? fixDevice(p.deviceId) : [];
  if (fixed.length) (r as any).fixed = fixed;
  journal({ kind: 'maintenance', by: r.by, devices: [p.deviceId], text: `Maintenance on ${p.deviceId}: ${r.status}${r.cause ? `, cause: ${r.cause}` : ''}${r.action ? `, action: ${r.action}` : ''}${r.notes ? `, notes: ${r.notes}` : ''}` });
  note(p.deviceId, `${r.by}: ${r.status}${r.cause ? ` · cause: ${r.cause}` : ''}`);
  return r;
}

export function history(deviceId?: string) {
  return records.filter(r => !deviceId || r.deviceId === deviceId).sort((a, b) => b.at - a.at);
}
