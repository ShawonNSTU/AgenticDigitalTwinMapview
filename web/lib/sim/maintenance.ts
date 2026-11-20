// Technician side: alerts raised by devices that are not healthy, and the records technicians keep while they
// investigate. An alert carries where the device is, what it reports, its recent events, the troubleshooting
// guidance from the diagnosis and the open/acknowledged/investigating/resolved status from the records.
import { randomBytes } from 'node:crypto';
import { DEV, ROOMS, TYPES, activeFault, FAULT_DOCS } from './engine';
import { device, rt, tick } from './runtime';

export type Status = 'new' | 'acknowledged' | 'investigating' | 'resolved';
export type Record_ = { id: string; deviceId: string; at: number; by: string; status: Exclude<Status, 'new'>; cause: string; action: string; notes: string; alert: string };

type Seen = { since: number; title: string; level: string };
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
    if (!seen[key]) { seen[key] = { since: Date.now(), title, level: s.health }; note(d.id, `Alert raised: ${title}`); }
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
      status: (recs[0]?.status ?? 'new') as Status,
      events: [...(events[d.id] ?? []), ...rt.log.filter(l => l.deviceId === d.id).slice(-5).map(l => ({ at: 0, text: `Command ${l.command} by ${l.by} at ${String(Math.floor(l.at)).padStart(2, '0')}:${String(Math.round((l.at % 1) * 60)).padStart(2, '0')}` }))].slice(-8),
    });
  }
  for (const k of Object.keys(seen)) if (!live.has(k)) { note(k.split('|')[0], `Back to normal: ${seen[k].title}`); delete seen[k]; }
  const rank = { fault: 0, watch: 1 } as Record<string, number>;
  return out.sort((a, b) => (rank[a.level] - rank[b.level]) || (b.since - a.since));
}

export function addRecord(p: { deviceId: string; status: Exclude<Status, 'new'>; cause?: string; action?: string; notes?: string; by?: string; alert?: string }) {
  if (!DEV.some((d: any) => d.id === p.deviceId)) throw new Error(`Unknown device ${p.deviceId}`);
  const r: Record_ = { id: randomBytes(6).toString('hex'), deviceId: p.deviceId, at: Date.now(), by: (p.by ?? 'Technician').slice(0, 40), status: p.status,
    cause: (p.cause ?? '').slice(0, 300), action: (p.action ?? '').slice(0, 300), notes: (p.notes ?? '').slice(0, 1000), alert: (p.alert ?? '').slice(0, 160) };
  records.push(r);
  note(p.deviceId, `${r.by}: ${r.status}${r.cause ? ` · cause: ${r.cause}` : ''}`);
  return r;
}

export function history(deviceId?: string) {
  return records.filter(r => !deviceId || r.deviceId === deviceId).sort((a, b) => b.at - a.at);
}
