// Bring a SmartThings account's devices onto the twin when the host connects (POST /api/integrations {token}).
//
// Every device in the account is read with its room and category, and given the twin's device type for it
// (lights, AC, TV, blinds, locks, sensors, appliances; hubs and phones are skipped). Then:
//   * on the 4th floor, they go to the SmartThings Experience Zone, the room that holds the real kit (unless their
//     SmartThings room is named after another room of the floor, e.g. "Training Room 403"). A twin
//     device with the same name is linked to it; otherwise a twin device of the same type whose name no real device
//     has takes it over (renamed, same spot in the room); otherwise it is added at a free spot that suits its type.
//     Twin devices left without a real one stay simulated, and can be removed;
//   * on any other floor, a device goes to the twin room with the name of its SmartThings room (same rules), and
//     devices whose room has no match are listed so the host can link them by hand.
// A linked device takes its commands and status from SmartThings (lib/integrations/smartthings.ts).
import * as ST from './smartthings';
import { DEV, ROOMS, byId } from '@/lib/sim/engine';
import { addDevice, removeDevice, renameDevice, rt } from '@/lib/sim/runtime';
import { MOUNT } from '@/lib/layout';
import { NOT_IN_ZONE } from './zone-devices';

export type AcctDevice = { stId: string; label: string; room: string; category: string; capabilities: string[]; type: string | null };
export type SyncResult = {
  found: number; room: string | null; already: number;
  linked: { localId: string; label: string; how: 'name' | 'slot' | 'added' }[];
  unplaced: { label: string; type: string | null; room: string; reason: string }[];
  simulated: { localId: string; name: string }[];
};

const ZONE = 'smartthings-experience-zone';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nameOf = (d: any) => String(d.name).split(' · ')[0];

/** The twin's device type for a SmartThings device, from its category and capabilities. Null: nothing to show. */
export function typeFor(category: string, caps: string[]): string | null {
  const c = new Set(caps), cat = category.toLowerCase();
  const has = (...k: string[]) => k.some(x => c.has(x));
  if (has('lock')) return 'lock';
  if (has('airConditionerMode') || /aircondition/.test(cat)) return 'ac';
  if (/television|tv/.test(cat) || has('tvChannel', 'mediaInputSource')) return 'tv';
  if (has('windowShade', 'windowShadeLevel') || /blind|shade|curtain/.test(cat)) return 'blinds';
  if (has('robotCleanerMovement') || /robotcleaner|vacuum/.test(cat)) return 'vacuum';
  if (has('airPurifierFanMode') || /airpurifier/.test(cat)) return 'purifier';
  if (/refrigerator/.test(cat) || has('refrigeration')) return 'fridge';
  if (/oven|microwave|range|cooktop/.test(cat)) return 'oven';
  if (/washer/.test(cat) || has('washerOperatingState')) return 'washer';
  if (/dryer/.test(cat) || has('dryerOperatingState')) return 'dryer';
  if (/doorbell/.test(cat)) return 'doorbell';
  if (/camera/.test(cat) || has('videoCamera', 'videoStream', 'imageCapture')) return 'camera';
  if (has('waterSensor') || /leak|water/.test(cat)) return 'leak';
  if (has('motionSensor') || /motion|presence/.test(cat) && has('motionSensor')) return 'motion';
  if (/fan/.test(cat) && has('fanSpeed', 'switch')) return 'fan';
  if (/light|bulb|lamp/.test(cat) || has('switchLevel', 'colorControl', 'colorTemperature')) return 'light';
  if (has('temperatureMeasurement', 'relativeHumidityMeasurement') && !has('switch')) return 'temphum';
  if (/speaker/.test(cat) || (has('audioVolume') && !has('tvChannel'))) return 'speaker';
  if (has('switch') || /plug|outlet|switch/.test(cat)) return 'plug';
  return null;
}

/** Every device in the account, with its SmartThings room name and the twin type for it. */
export async function accountDevices(): Promise<AcctDevice[]> {
  const [devs, rooms] = await Promise.all([ST.accountDevicesFull(), ST.accountRooms().catch(() => ({} as Record<string, string>))]);
  return devs.map(d => ({ stId: d.stId, label: d.label, room: (d.roomId && rooms[d.roomId]) || '', category: d.category, capabilities: d.capabilities, type: typeFor(d.category, d.capabilities) }));
}

/* ---------------- a free spot in a room for a device of a given type ---------------- */
type V = [number, number];
const polyOf = (r: any): V[] => r.poly?.length >= 3 ? r.poly : [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]];
function inside(P: V[], x: number, z: number) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const WALL = new Set(['tv', 'blinds', 'lock', 'temphum', 'plug', 'doorbell']);
const CEILING = new Set(['light', 'ac', 'camera', 'motion']);

/** A spot for a new device: wall units on a wall facing into the room, ceiling units on the ceiling, the rest on
 *  the floor near a wall; always as far as possible from the devices already there and clear of the doors. */
export function spotFor(roomKey: string, type: string): { x: number; z: number; rot: number } | null {
  const r = ROOMS.find((x: any) => x.key === roomKey) as any;
  if (!r) return null;
  const P = polyOf(r);
  const others = DEV.filter((d: any) => d.room === roomKey).map((d: any) => [d.p[0], d.p[2]] as V);
  const doors = rt.furniture.filter(f => f.kind === 'door').map(f => [f.x, f.z] as V);
  const cands: { p: V; rot: number }[] = [];
  if (WALL.has(type) || !CEILING.has(type)) {
    const inset = WALL.has(type) ? 0.07 : 0.45;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.8) continue;
      const u: V = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      let n: V = [-u[1], u[0]];
      const mid: V = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inside(P, mid[0] + n[0] * 0.15, mid[1] + n[1] * 0.15)) n = [-n[0], -n[1]];
      for (let t = 0.4; t <= L - 0.4; t += 0.3) {
        const p: V = [a[0] + u[0] * t + n[0] * inset, a[1] + u[1] * t + n[1] * inset];
        if (inside(P, p[0], p[1])) cands.push({ p, rot: Math.atan2(n[0], n[1]) });
      }
    }
  }
  if (CEILING.has(type) || !cands.length) {
    const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
    for (let x = Math.min(...xs) + 0.5; x <= Math.max(...xs) - 0.5; x += 0.4)
      for (let z = Math.min(...zs) + 0.5; z <= Math.max(...zs) - 0.5; z += 0.4)
        if (inside(P, x, z) && P.every((q, i) => { const w = P[(i + 1) % P.length]; return segDist([x, z], q, w) > 0.45; })) cands.push({ p: [x, z], rot: 0 });
  }
  if (!cands.length) return null;
  const score = (p: V) => {
    const dDev = Math.min(9, ...others.map(o => Math.hypot(o[0] - p[0], o[1] - p[1])));
    const dDoor = Math.min(9, ...doors.map(o => Math.hypot(o[0] - p[0], o[1] - p[1])));
    return Math.min(dDev, 3) + (dDoor < 1.0 ? -5 : 0) + 0.01 * dDev;
  };
  const best = cands.reduce((a, b) => (score(b.p) > score(a.p) ? b : a));
  return { x: +best.p[0].toFixed(3), z: +best.p[1].toFixed(3), rot: +best.rot.toFixed(4) };
}
function segDist(p: V, a: V, b: V) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

/* ---------------- the sync ---------------- */
async function linkTo(localId: string, a: AcctDevice) {
  ST.setLink({ localId, stId: a.stId, component: 'main', label: a.label, type: byId[localId].type, capabilities: a.capabilities });
  await ST.refresh(localId, byId[localId].type).catch(() => null);
}

/** Link or place every device of the connected account (see the top of this file). */
export async function syncAccount(): Promise<SyncResult> {
  const acct = await accountDevices();
  const zone = rt.floor === 'preset' && ROOMS.some((r: any) => r.key === ZONE) ? ZONE : null;
  const res: SyncResult = { found: acct.length, already: 0, room: zone ? (ROOMS.find((r: any) => r.key === ZONE) as any).name : null, linked: [], unplaced: [], simulated: [] };
  const byRoomName = (name: string): string | null => {
    if (!name) return null;
    const n = norm(name);
    const r = (ROOMS as any[]).find(x => norm(x.name) === n || norm(String(x.label ?? '')) === n) ?? (ROOMS as any[]).find(x => n.length > 3 && (norm(x.name).includes(n) || n.includes(norm(x.name))));
    return r?.key ?? null;
  };
  // 4th floor: the zone, unless the SmartThings room names another room of the floor
  const roomFor = (a: AcctDevice): string | null => zone ? (byRoomName(a.room) ?? zone) : byRoomName(a.room);
  const realNames = new Set(acct.map(a => norm(a.label)));
  const linkedSt = new Set(ST.links().map(l => l.stId));
  const todo: { a: AcctDevice; room: string }[] = [];
  for (const a of acct) {
    if (linkedSt.has(a.stId)) { res.already += 1; continue; }
    if (zone && NOT_IN_ZONE.some(x => x.stId === a.stId)) { res.unplaced.push({ label: a.label, type: a.type, room: a.room, reason: 'not in the SmartThings Experience Zone' }); continue; }
    if (!a.type) { res.unplaced.push({ label: a.label, type: null, room: a.room, reason: `not a device the map shows (${a.category || 'no category'})` }); continue; }
    const room = roomFor(a);
    if (!room) { res.unplaced.push({ label: a.label, type: a.type, room: a.room, reason: a.room ? `no room named “${a.room}” on this floor` : 'not in a SmartThings room' }); continue; }
    todo.push({ a, room });
  }
  const free = (d: any) => !ST.link(d.id);
  // 1. same name in the same room
  for (const t of [...todo]) {
    const d = (DEV as any[]).find(x => x.room === t.room && free(x) && norm(nameOf(x)) === norm(t.a.label));
    if (!d) continue;
    await linkTo(d.id, t.a); res.linked.push({ localId: d.id, label: t.a.label, how: 'name' });
    todo.splice(todo.indexOf(t), 1);
  }
  // 2. a twin device of the same type that no real device is named after takes the real one over
  for (const t of [...todo]) {
    const d = (DEV as any[]).find(x => x.room === t.room && free(x) && x.type === t.a.type && !realNames.has(norm(nameOf(x))));
    if (!d) continue;
    renameDevice(d.id, t.a.label);
    await linkTo(d.id, t.a); res.linked.push({ localId: d.id, label: t.a.label, how: 'slot' });
    todo.splice(todo.indexOf(t), 1);
  }
  // 3. a new device at a free spot that suits it
  for (const t of todo) {
    const s = spotFor(t.room, t.a.type!);
    if (!s) { res.unplaced.push({ label: t.a.label, type: t.a.type, room: t.a.room, reason: 'no free spot in the room' }); continue; }
    const made: any = addDevice({ type: t.a.type!, x: s.x, z: s.z, y: MOUNT[t.a.type!] ?? 1, rotationY: s.rot, room: t.room, name: t.a.label });
    if (!made.ok) { res.unplaced.push({ label: t.a.label, type: t.a.type, room: t.a.room, reason: made.error }); continue; }
    await linkTo(made.device.id, t.a); res.linked.push({ localId: made.device.id, label: t.a.label, how: 'added' });
  }
  if (zone) res.simulated = (DEV as any[]).filter(x => x.room === zone && free(x)).map(x => ({ localId: x.id, name: nameOf(x) }));
  return res;
}

/** Remove the twin devices in a room that have no real SmartThings device (after a sync). */
export function removeSimulated(roomKey = ZONE) {
  const gone = (DEV as any[]).filter(x => x.room === roomKey && !ST.link(x.id)).map(x => x.id);
  for (const id of gone) removeDevice(id);
  return gone;
}
