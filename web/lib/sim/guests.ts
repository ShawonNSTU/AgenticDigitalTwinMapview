// Guest passes: a link (shown as a QR code) that lets a visitor walk from an entrance to one room and
// see and control only the devices in that room. Everything a guest's browser loads goes through
// /api/guest/<token>/..., which filters by the pass; nothing else is reachable with a token.
import { guestReady, GUEST_HIDDEN, ST_PROFILE, ST_KIND_COMMANDS, ARRIVAL } from './stzone';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { DEV, ROOMS, TYPES, LAYOUT, byId } from './engine';
import { buildingState, floor, device, COMMANDS, rt } from './runtime';
import { dispatch } from './dispatch';
import { audit, markStepUp, stepUpFresh, unlocksRecently, policy } from './access';
import { info as stInfo, supported } from '@/lib/integrations/smartthings';
import { bindTag, fixOf } from './positioning';

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
  controls: string[];  // device types the guest may control ([] = all in the room); others are view-only
  acRange: [number, number]; // AC set-point limits for this guest
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
  if (pin.trim() === p.pin) { p.failed = 0; markStepUp(token); return { cookie: sign(token) }; }
  p.failed += 1;
  if (p.failed >= 5) { p.revoked = true; return { error: 'Too many wrong PINs. The link was locked; ask the front desk for a new one.', status: 410 }; }
  return { error: `That PIN is not right (${5 - p.failed} tries left).`, status: 401 };
}

const g = globalThis as unknown as { __guests?: Record<string, GuestPass> };
const passes: Record<string, GuestPass> = (g.__guests ??= {});

const ENTRANCE = /lift|elevator|lobby|reception|entrance|entry|foyer|stair/i;
const roomOf = (key: string) => ROOMS.find((r: any) => r.key === key) as any;
const roomName = (r: any) => String(r?.label ?? r?.name ?? '').split('\n')[0] || r?.key;

/** Rooms a walk can sensibly start from, best first: the floor's arrival point (where guests come up to the
 *  floor; set for the 4th floor in lib/sim/stzone.ts), then lifts and lobbies, then other stairs and entrances.
 *  Stairs closed in behind service rooms (no way through to the guest rooms) are left out. */
const rank = (key: string, name: string) => key === ARRIVAL.key ? 0 : /lift|elevator|lobby|reception/i.test(name) ? 1 : /entrance|entry|foyer/i.test(name) ? 2 : 3;
export function entranceRooms() {
  return ROOMS.filter((r: any) => ENTRANCE.test(`${r.name} ${r.label ?? ''}`) && !ARRIVAL.closed.includes(r.key))
    .map((r: any) => ({ key: r.key, name: roomName(r) }))
    .sort((a, b) => rank(a.key, a.name) - rank(b.key, b.name));
}

/** Where a guest's walk starts when the host doesn't choose: the floor's arrival point, else a lift or lobby;
 *  '' (nearest door to the outside) if the plan has neither. */
export function defaultEntrance() {
  const best = entranceRooms()[0];
  return best && rank(best.key, best.name) <= 1 ? best.key : '';
}

export function createPass(room: string, hours: number, entrance = '', label = '', opts: { until?: number; verify?: boolean; allowUnlock?: boolean; tag?: string; controls?: string[]; acRange?: [number, number] } = {}) {
  if (!roomOf(room)) throw new Error(`Unknown room ${room}`);
  if (!guestReady(room)) throw new Error('This room has no SmartThings devices for a guest yet: run Hotel setup for it first');
  if (!entrance) entrance = defaultEntrance();
  if (entrance && !roomOf(entrance)) throw new Error(`Unknown entrance ${entrance}`);
  const now = Date.now();
  const expiresAt = opts.until && opts.until > now ? opts.until : now + hours * 3600_000;
  if (expiresAt - now > 31 * 24 * 3600_000) throw new Error('A stay can be at most 31 days');
  const pin = opts.verify ? String(100000 + (randomBytes(4).readUInt32BE() % 900000)) : '';
  if (opts.allowUnlock && !pin) throw new Error('Unlocking needs identity verification (a check-in PIN)');
  const p: GuestPass = { token: randomBytes(18).toString('base64url'), room, entrance, label: label.slice(0, 60), layout: rt.planGen ?? 0, createdAt: now, expiresAt, revoked: false, pin, allowUnlock: !!opts.allowUnlock, failed: 0, controls: opts.controls ?? [], acRange: opts.acRange && opts.acRange[0] < opts.acRange[1] ? [Math.max(16, opts.acRange[0]), Math.min(30, opts.acRange[1])] : [16, 30] };
  passes[p.token] = p;
  if (opts.tag) bindTag(opts.tag.slice(0, 64), p.token); // the guest's location badge in the hotel's positioning system
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
  return { controls: p.controls, acRange: p.acRange, token: p.token, room: p.room, roomName: roomName(roomOf(p.room)), entrance: p.entrance, entranceName: p.entrance ? roomName(roomOf(p.entrance)) : '', label: p.label, createdAt: p.createdAt, expiresAt: p.expiresAt, path: `/guest/${p.token}`, pin: p.pin, allowUnlock: p.allowUnlock };
}

/** Commands a guest may run on a device: everything that needs no confirmation (no unlocking, no stopping a wash). */
export function guestCommands(type: string, p?: GuestPass, id?: string, withHidden = false) {
  // the host's choice of controls for this guest (others are view-only), then what the real device supports
  if (p?.controls?.length && !p.controls.includes(type)) return [];
  const list = Object.entries(COMMANDS[type] ?? {})
    .filter(([, c]) => withHidden || !c.hidden)
    .filter(([name, c]) => !c.confirm || (type === 'lock' && name === 'unlock' && !!p?.allowUnlock && !!p?.pin))
    .map(([name, c]) => ({ name, args: (name === 'setTemperature' && p ? { celsius: p.acRange } : c.args ?? {}) as Record<string, any>, ...(c.confirm ? { confirm: true } : {}) }));
  const prof = id ? ST_PROFILE[id] : undefined;
  const own = prof ? list.filter(c => ST_KIND_COMMANDS[prof.kind].includes(c.name) || (withHidden && prof.kind === 'color' && c.name === 'setHueSat')) : list;
  return id ? supported(id, type, own) : own;
}

const inRoom = (p: GuestPass) => DEV.filter((d: any) => d.room === p.room && !GUEST_HIDDEN.includes(d.type));

/** What the guest page shows: the room, its devices with their state and allowed commands. */
export function guestView(p: GuestPass) {
  const r = roomOf(p.room);
  return {
    room: { key: p.room, name: roomName(r) },
    entrance: p.entrance ? { key: p.entrance, name: roomName(roomOf(p.entrance)) } : null,
    title: rt.title,
    expiresAt: p.expiresAt,
    guestName: p.label,
    lock: lockInfo(),
    allowUnlock: p.allowUnlock,
    entrances: entranceRooms(),
    devices: inRoom(p).map((d: any) => {
      const s = device(d.id)!;
      return {
        id: d.id, type: d.type, label: TYPES[d.type].label, name: String(d.name).split(' · ')[0], health: s.health, online: (s as any).online !== false,
        readings: s.readings, overrides: s.overrides ?? {},
        status: s.parts.slice(0, 3).map((x: any) => ({ name: x.name, value: x.value, health: x.health })),
        finding: s.finding ? { title: (s.finding as any).title, lvl: (s.finding as any).lvl } : null,
        commands: guestCommands(d.type, p, d.id),
        ...(ST_PROFILE[d.id] ? { st: ST_PROFILE[d.id] } : {}),
      };
    }),
  };
}

/** The layout for the guest's 3D view: walls, doors and furniture to walk through, but only the
 *  guest room's devices, no plan image and no printed notes. */
export function guestBuilding(p: GuestPass) {
  const b = buildingState();
  return { ...b, devices: b.devices.filter(d => d.room === p.room && !GUEST_HIDDEN.includes(d.type)), notes: [], plan: null, guest: { room: p.room, entrance: p.entrance } };
}

export function guestFloor(p: GuestPass) {
  const f = floor();
  const me = fixOf(p.token);
  return { ...f, devices: f.devices.filter((d: any) => d.room === p.room && !GUEST_HIDDEN.includes(d.type)), ...(me ? { me } : {}) };
}

export async function guestCommand(p: GuestPass, id: string, command: string, args: Record<string, unknown>, pin?: string) {
  const d = byId[id];
  if (!d || d.room !== p.room || GUEST_HIDDEN.includes(d.type)) return { status: 403, body: { ok: false, error: 'This device is not in your room.' } };
  const allowed = guestCommands(d.type, p, id, true).find(c => c.name === command);
  const who = `guest ${p.label || p.token.slice(0, 6)}`;
  if (!allowed) {
    if (command === 'unlock') audit({ deviceId: id, room: d.room, action: 'unlock', by: who, ok: false, reason: 'not allowed by the pass', via: 'simulator' });
    return { status: 403, body: { ok: false, error: `Guests can't use "${command}" on this device.` } };
  }
  if (command === 'setTemperature') {
    const c = Number(args.celsius);
    if (!(c >= p.acRange[0] && c <= p.acRange[1])) return { status: 403, body: { ok: false, error: `The hotel allows ${p.acRange[0]}–${p.acRange[1]} °C in this room.` } };
  }
  if (command === 'unlock') {
    // the hotel's access policy: identity re-checked recently, not too many unlocks, within the stay
    if (pin) { const v = verifyPin(p.token, pin); if ('error' in v) return { status: v.status, body: { ok: false, error: v.error } }; }
    if (!stepUpFresh(p.token)) return { status: 428, body: { ok: false, stepUp: true, error: 'Enter your check-in PIN to unlock the door.' } };
    if (unlocksRecently(who) >= policy().maxUnlocksPer10Min) {
      audit({ deviceId: id, room: d.room, action: 'unlock', by: who, ok: false, reason: 'too many unlocks', via: 'simulator' });
      return { status: 429, body: { ok: false, error: 'Too many unlocks in a short time. Please contact the front desk.' } };
    }
  }
  const r = await dispatch(id, command, args, !!(allowed as any).confirm, who);
  return { status: r.ok ? 200 : r.offline ? 503 : 400, body: r.ok ? { ok: true, via: r.via, ...(r.note ? { note: r.note } : {}), ...(command === 'unlock' && policy().autoRelockSec ? { relockIn: policy().autoRelockSec } : {}) } : { ok: false, error: r.error, offline: !!r.offline } };
}

/** How the room's lock is connected, for the guest page. */
export const lockInfo = () => ({ integration: stInfo().configured ? 'smartthings' : 'simulator', autoRelockSec: policy().autoRelockSec });
