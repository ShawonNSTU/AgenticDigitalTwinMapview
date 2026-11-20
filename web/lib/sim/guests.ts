// Guest passes: a link (shown as a QR code) that lets a visitor walk from an entrance to one room and
// see and control only the devices in that room. Everything a guest's browser loads goes through
// /api/guest/<token>/..., which filters by the pass; nothing else is reachable with a token.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
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
  pin: string;         // check-in PIN the host hands over ('' = no verification)
  allowUnlock: boolean; // hotel policy: the verified guest may unlock their own room's door
  failed: number;      // wrong PIN attempts (5 locks the pass)
};

// Verified guests get a cookie signed with this process's secret, so the PIN is asked once per browser.
const gs = globalThis as unknown as { __guestSecret?: Buffer };
const SECRET: Buffer = (gs.__guestSecret ??= randomBytes(32));
export const cookieName = (token: string) => `gv_${token.slice(0, 12)}`;
const sign = (token: string) => createHmac('sha256', SECRET).update(token).digest('base64url');
export function isVerified(p: GuestPass, cookie: string | undefined) {
  if (!p.pin) return true;
  if (!cookie) return false;
  const a = Buffer.from(cookie), b = Buffer.from(sign(p.token));
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Checks the PIN; returns the cookie value to set, or an error. Five wrong tries withdraw the pass. */
export function verifyPin(token: string, pin: string): { cookie: string } | { error: string; status: number } {
  const p = passes[token];
  if (!p || p.revoked) return { error: 'This guest link is not valid.', status: 404 };
  if (!p.pin) return { cookie: sign(token) };
  if (pin.trim() === p.pin) { p.failed = 0; return { cookie: sign(token) }; }
  p.failed += 1;
  if (p.failed >= 5) { p.revoked = true; return { error: 'Too many wrong PINs. The link was locked; ask the front desk for a new one.', status: 410 }; }
  return { error: `That PIN is not right (${5 - p.failed} tries left).`, status: 401 };
}

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

export function createPass(room: string, hours: number, entrance = '', label = '', opts: { until?: number; verify?: boolean; allowUnlock?: boolean } = {}) {
  if (!roomOf(room)) throw new Error(`Unknown room ${room}`);
  if (entrance && !roomOf(entrance)) throw new Error(`Unknown entrance ${entrance}`);
  const now = Date.now();
  const expiresAt = opts.until && opts.until > now ? opts.until : now + hours * 3600_000;
  if (expiresAt - now > 31 * 24 * 3600_000) throw new Error('A stay can be at most 31 days');
  const pin = opts.verify ? String(100000 + (randomBytes(4).readUInt32BE() % 900000)) : '';
  if (opts.allowUnlock && !pin) throw new Error('Unlocking needs identity verification (a check-in PIN)');
  const p: GuestPass = { token: randomBytes(18).toString('base64url'), room, entrance, label: label.slice(0, 60), layout: rt.planGen ?? 0, createdAt: now, expiresAt, revoked: false, pin, allowUnlock: !!opts.allowUnlock, failed: 0 };
  passes[p.token] = p;
  return describe(p);
}

/** A usable pass, or why it can't be used. */
export function check(token: string, cookie?: string | null, needVerified = true): { pass: GuestPass } | { error: string; status: number; verify?: boolean } {
  const p = passes[token];
  if (!p) return { error: 'This guest link is not valid.', status: 404 };
  if (p.revoked) return { error: 'This guest link was withdrawn by the host.', status: 410 };
  if (Date.now() > p.expiresAt) return { error: 'This guest link has expired.', status: 410 };
  if (p.layout !== (rt.planGen ?? 0) || !roomOf(p.room)) return { error: 'The floor plan changed since this link was made; ask the host for a new one.', status: 410 };
  if (needVerified && !isVerified(p, cookie ?? undefined)) return { error: 'Enter the check-in PIN from the front desk.', status: 401, verify: true };
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
    .filter(p => !p.revoked && p.expiresAt > now && p.layout === (rt.planGen ?? 0) && (!room || p.room === room))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(describe);
}

function describe(p: GuestPass) {
  return { token: p.token, room: p.room, roomName: roomName(roomOf(p.room)), entrance: p.entrance, entranceName: p.entrance ? roomName(roomOf(p.entrance)) : '', label: p.label, createdAt: p.createdAt, expiresAt: p.expiresAt, path: `/guest/${p.token}`, pin: p.pin, allowUnlock: p.allowUnlock };
}

/** Commands a guest may run on a device: everything that needs no confirmation (no unlocking, no stopping a wash). */
export function guestCommands(type: string, p?: GuestPass) {
  return Object.entries(COMMANDS[type] ?? {})
    .filter(([name, c]) => !c.confirm || (type === 'lock' && name === 'unlock' && !!p?.allowUnlock && !!p?.pin))
    .map(([name, c]) => ({ name, args: c.args ?? {}, ...(c.confirm ? { confirm: true } : {}) }));
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
    guestName: p.label,
    allowUnlock: p.allowUnlock,
    entrances: entranceRooms(),
    devices: inRoom(p).map((d: any) => {
      const s = device(d.id)!;
      return {
        id: d.id, type: d.type, label: TYPES[d.type].label, name: String(d.name).split(' · ')[0], health: s.health, online: (s as any).online !== false,
        readings: s.readings, overrides: s.overrides ?? {},
        status: s.parts.slice(0, 3).map((x: any) => ({ name: x.name, value: x.value, health: x.health })),
        finding: s.finding ? { title: (s.finding as any).title, lvl: (s.finding as any).lvl } : null,
        commands: guestCommands(d.type, p),
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
  const allowed = guestCommands(d.type, p).find(c => c.name === command);
  if (!allowed) return { status: 403, body: { ok: false, error: `Guests can't use "${command}" on this device.` } };
  // unlocking is allowed only by hotel policy, for a verified guest, on their own room's lock (simulated integration)
  const r: any = runCommand(id, command, args, !!(allowed as any).confirm, 'guest');
  return { status: r.ok ? 200 : r.offline ? 503 : 400, body: r.ok ? { ok: true } : { ok: false, error: r.error, offline: !!r.offline } };
}
