// Guest passes: a link (shown as a QR code) that lets a visitor walk from an entrance to one room and
// see and control only the devices in that room. Everything a guest's browser loads goes through
// /api/guest/<token>/..., which filters by the pass; nothing else is reachable with a token.
import { randomBytes } from 'node:crypto';
import { DEV, ROOMS, TYPES, LAYOUT, byId } from './engine';
import { buildingState, floor, device, runCommand, COMMANDS, rt } from './runtime';

export type GuestPass = {
  token: string;
  room: string;        // room key the guest may enter and control
  entrance: string;    // room key the walk starts from ('' = the renderer picks the entrance)
  label: string;       // who the pass is for (optional, shown to the host)
  layout: number;      // layout version the pass was made for; a new plan upload invalidates it
  createdAt: number;   // ms
  expiresAt: number;   // ms
  revoked: boolean;
};

const g = globalThis as unknown as { __guests?: Record<string, GuestPass> };
const passes: Record<string, GuestPass> = (g.__guests ??= {});

const ENTRANCE = /lift|elevator|lobby|reception|entrance|entry|foyer|stair/i;
const roomOf = (key: string) => ROOMS.find((r: any) => r.key === key) as any;
const roomName = (r: any) => String(r?.label ?? r?.name ?? '').split('\n')[0] || r?.key;

/** Rooms a walk can sensibly start from (lifts, lobbies, stairs, entrances), best first. */
export function entranceRooms() {
  return ROOMS.filter((r: any) => ENTRANCE.test(`${r.name} ${r.label ?? ''}`))
    .map((r: any) => ({ key: r.key, name: roomName(r) }))
    .sort((a, b) => (/lift|elevator|lobby|reception|entrance|entry|foyer/i.test(a.name) ? 0 : 1) - (/lift|elevator|lobby|reception|entrance|entry|foyer/i.test(b.name) ? 0 : 1));
}

export function createPass(room: string, hours: number, entrance = '', label = '') {
  if (!roomOf(room)) throw new Error(`Unknown room ${room}`);
  if (entrance && !roomOf(entrance)) throw new Error(`Unknown entrance ${entrance}`);
  const now = Date.now();
  const p: GuestPass = { token: randomBytes(18).toString('base64url'), room, entrance, label: label.slice(0, 60), layout: LAYOUT.version, createdAt: now, expiresAt: now + hours * 3600_000, revoked: false };
  passes[p.token] = p;
  return describe(p);
}

/** A usable pass, or why it can't be used. */
export function check(token: string): { pass: GuestPass } | { error: string; status: number } {
  const p = passes[token];
  if (!p) return { error: 'This guest link is not valid.', status: 404 };
  if (p.revoked) return { error: 'This guest link was withdrawn by the host.', status: 410 };
  if (Date.now() > p.expiresAt) return { error: 'This guest link has expired.', status: 410 };
  if (p.layout !== LAYOUT.version || !roomOf(p.room)) return { error: 'The floor plan changed since this link was made; ask the host for a new one.', status: 410 };
  return { pass: p };
}

export function revoke(token: string) {
  const p = passes[token];
  if (!p) return false;
  p.revoked = true;
  return true;
}

export function listPasses(room?: string) {
  const now = Date.now();
  return Object.values(passes)
    .filter(p => !p.revoked && p.expiresAt > now && p.layout === LAYOUT.version && (!room || p.room === room))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(describe);
}

function describe(p: GuestPass) {
  return { token: p.token, room: p.room, roomName: roomName(roomOf(p.room)), entrance: p.entrance, entranceName: p.entrance ? roomName(roomOf(p.entrance)) : '', label: p.label, createdAt: p.createdAt, expiresAt: p.expiresAt, path: `/guest/${p.token}` };
}

/** Commands a guest may run on a device: everything that needs no confirmation (no unlocking, no stopping a wash). */
export function guestCommands(type: string) {
  return Object.entries(COMMANDS[type] ?? {}).filter(([, c]) => !c.confirm).map(([name, c]) => ({ name, args: c.args ?? {} }));
}

const inRoom = (p: GuestPass) => DEV.filter((d: any) => d.room === p.room);

/** What the guest page shows: the room, its devices with their state and allowed commands. */
export function guestView(p: GuestPass) {
  const r = roomOf(p.room);
  return {
    room: { key: p.room, name: roomName(r) },
    entrance: p.entrance ? { key: p.entrance, name: roomName(roomOf(p.entrance)) } : null,
    title: rt.title,
    expiresAt: p.expiresAt,
    devices: inRoom(p).map((d: any) => {
      const s = device(d.id)!;
      return {
        id: d.id, type: d.type, label: TYPES[d.type].label, name: d.name, health: s.health,
        readings: s.readings, overrides: s.overrides ?? {},
        status: s.parts.slice(0, 3).map((x: any) => ({ name: x.name, value: x.value, health: x.health })),
        finding: s.finding ? { title: (s.finding as any).title, lvl: (s.finding as any).lvl } : null,
        commands: guestCommands(d.type),
      };
    }),
  };
}

/** The layout for the guest's 3D view: walls, doors and furniture to walk through, but only the
 *  guest room's devices, no plan image and no printed notes. */
export function guestBuilding(p: GuestPass) {
  const b = buildingState();
  return { ...b, devices: b.devices.filter(d => d.room === p.room), notes: [], plan: null, guest: { room: p.room, entrance: p.entrance } };
}

export function guestFloor(p: GuestPass) {
  const f = floor();
  return { ...f, devices: f.devices.filter(d => d.room === p.room) };
}

export function guestCommand(p: GuestPass, id: string, command: string, args: Record<string, unknown>) {
  const d = byId[id];
  if (!d || d.room !== p.room) return { status: 403, body: { ok: false, error: 'This device is not in your room.' } };
  if (!guestCommands(d.type).some(c => c.name === command)) return { status: 403, body: { ok: false, error: `Guests can't use "${command}" on this device.` } };
  const r = runCommand(id, command, args, false, 'guest');
  return { status: r.ok ? 200 : 400, body: r.ok ? { ok: true } : { ok: false, error: r.error } };
}
