// "The room knows you're coming." Each guest stay has a journey:
//
//   booked → en_route → preparing → ready → arrived ⇄ away → departed
//
//   en_route   the guest said they are on their way (with minutes), started the walk from the entrance, or the
//              hotel's positioning sees them in the building; the ETA comes from that
//   preparing  the room is pre-conditioned in time for the ETA: the lead time is how long the AC needs to reach the
//              guest's temperature (about 2.5 min per °C, 2-15 min). The welcome scene runs through the same
//              device layer as everything else, so the zone's REAL SmartThings lights and shade move too
//   ready      the room is at the guest's temperature (±0.7 °C) and every step is done
//   arrived    the guest reached the room (the walk ended there, their position is in the room, or they unlocked)
//   away       the guest stepped out ("I'm heading out", or positioning sees them elsewhere for a while): eco
//   departed   checked out (pass withdrawn or expired): eco, curtain closed for privacy, housekeeping dispatched
//
// Eco periods are counted as avoided energy (energy.ts). Every step is journalled for the assistant.
import { DEV } from '@/lib/sim/engine';
import { device } from '@/lib/sim/runtime';
import { dispatch, type Result } from '@/lib/sim/dispatch';
import { ST_PROFILE } from '@/lib/sim/stzone';
import { listPasses, onCheckout, passOf, type GuestPass } from '@/lib/sim/guests';
import { fixOf } from '@/lib/sim/positioning';
import { log as journal } from '@/lib/kg/journal';
import { centroid, clamp, devName, num, polyOf, roomName, roomOf, round } from './geo';
import { roomComfort, setTarget } from './comfort';
import { endEco, startEco } from './energy';

export type Scene = 'warm' | 'bright' | 'calm' | 'off';
export type Prefs = { temp: number; scene: Scene; curtain: number; tvWelcome: boolean };
export type State = 'booked' | 'en_route' | 'preparing' | 'ready' | 'arrived' | 'away' | 'departed';
export type Step = { key: string; label: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string; via?: string; real?: boolean };
export type Journey = {
  token: string; room: string; roomName: string; guest: string; state: State; createdAt: number; updatedAt: number;
  eta: number | null; etaSource: 'guest' | 'walk' | 'position' | 'host' | null; distanceM: number | null;
  leadMin: number | null; prefs: Prefs; steps: Step[]; timeline: { at: number; state: State; text: string }[];
  preparedAt: number | null; readyAt: number | null; arrivedAt: number | null; departedAt: number | null;
};
export type Housekeeping = { id: string; room: string; roomName: string; at: number; status: 'requested' | 'in_progress' | 'done'; items: string[]; vacuum: string | null };

const DEFAULT_PREFS: Prefs = { temp: 23, scene: 'warm', curtain: 50, tvWelcome: true };
const WALK_MPS = 1.2;          // walking speed for ETAs from a distance
const AWAY_MS = 10 * 60_000;   // positioning sees the guest outside their room this long: away
const READY_BAND = 0.7;        // °C

const g = globalThis as unknown as { __arrival?: { journeys: Record<string, Journey>; housekeeping: Housekeeping[]; version: number; outside: Record<string, number> } };
const A = (g.__arrival ??= { journeys: {}, housekeeping: [], version: 0, outside: {} });
export const arrivalVersion = () => A.version;
const bump = () => { A.version++; };

function journeyFor(p: GuestPass): Journey {
  let j = A.journeys[p.token];
  if (!j) {
    j = A.journeys[p.token] = {
      token: p.token, room: p.room, roomName: roomName(p.room), guest: p.label, state: 'booked', createdAt: Date.now(), updatedAt: Date.now(),
      eta: null, etaSource: null, distanceM: null, leadMin: null, prefs: { ...DEFAULT_PREFS }, steps: [], timeline: [],
      preparedAt: null, readyAt: null, arrivedAt: null, departedAt: null,
    };
    mark(j, 'booked', `Checked in to ${j.roomName}`);
  }
  return j;
}

function mark(j: Journey, state: State, text: string) {
  j.state = state; j.updatedAt = Date.now();
  j.timeline.push({ at: Date.now(), state, text }); if (j.timeline.length > 30) j.timeline.shift();
  journal({ kind: 'arrival', room: j.room, guest: j.token, text: `${j.guest || 'Guest'} · ${j.roomName}: ${text}` });
  bump();
}

/** The journey of a stay (created on first use). null for an unknown token. */
export function journey(token: string): Journey | null {
  const p = passOf(token);
  if (!p) return A.journeys[token] ?? null;
  return journeyFor(p);
}

/** Every journey of a current stay, and the last few departures (staff view). */
export function journeys() {
  for (const p of listPasses()) { const pp = passOf(p.token); if (pp) journeyFor(pp); }
  return Object.values(A.journeys).filter(j => j.state !== 'departed' || Date.now() - (j.departedAt ?? 0) < 6 * 3600_000)
    .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity) || b.updatedAt - a.updatedAt);
}
export const housekeeping = () => A.housekeeping.slice(-20).reverse();

/** How long before arrival the room should start: the AC needs about 2.5 min per °C to close the gap. */
function leadMinutes(j: Journey) {
  const c = roomComfort(j.room);
  const gap = c ? Math.abs(c.temp - j.prefs.temp) : 2;
  return round(clamp(1 + gap * 2.5, 2, 15), 1);
}

/** The welcome scene for a room and the guest's preferences, as device commands (only what the room has). */
export function welcomeScene(room: string, prefs: Prefs): { id: string; command: string; args: Record<string, unknown>; label: string }[] {
  const out: { id: string; command: string; args: Record<string, unknown>; label: string }[] = [];
  const devs = (DEV as any[]).filter(d => d.room === room);
  const snap = (id: string) => { try { return (device(id) as any)?.readings ?? {}; } catch { return {}; } };
  const level = { warm: 60, bright: 100, calm: 25, off: 0 }[prefs.scene], ct = { warm: 2700, bright: 4000, calm: 2200, off: 2700 }[prefs.scene];
  for (const d of devs) {
    const name = devName(d.id), prof = ST_PROFILE[d.id], r = snap(d.id);
    if (d.type === 'ac') {
      const room0 = num(r.room, prefs.temp);
      if (r.on === false) out.push({ id: d.id, command: 'power', args: { on: 'true' }, label: `${name}: on` });
      out.push({ id: d.id, command: 'setMode', args: { mode: room0 > prefs.temp ? 'cool' : 'heat' }, label: `${name}: ${room0 > prefs.temp ? 'cooling' : 'heating'}` });
      out.push({ id: d.id, command: 'setTemperature', args: { celsius: prefs.temp }, label: `${name}: ${prefs.temp} °C` });
    } else if (d.type === 'blinds') {
      out.push({ id: d.id, command: 'setPosition', args: { percent: prefs.curtain }, label: `${name}: ${prefs.curtain === 0 ? 'closed' : prefs.curtain === 100 ? 'open' : `${prefs.curtain} % open`}` });
    } else if (d.type === 'light') {
      const window = /window/i.test(name) || d.fixture === 'window';
      if (window) { out.push({ id: d.id, command: 'power', args: { on: prefs.curtain > 0 ? 'true' : 'false' }, label: `${name}: ${prefs.curtain > 0 ? 'on (outside view)' : 'off'}` }); continue; }
      if (prefs.scene === 'off') continue;
      const ceiling = /tv lamp|ceiling/i.test(name);
      if (prof?.kind === 'switch') {
        const on = prefs.scene === 'calm' ? !ceiling : true;
        out.push({ id: d.id, command: 'power', args: { on: on ? 'true' : 'false' }, label: `${name}: ${on ? 'on' : 'off'}` });
      } else {
        out.push({ id: d.id, command: 'setLevel', args: { percent: ceiling && prefs.scene === 'calm' ? 0 : level }, label: `${name}: ${level} %` });
        if (level > 0) out.push({ id: d.id, command: 'setColorTemperature', args: { kelvin: ct }, label: `${name}: ${ct} K` });
      }
    } else if (d.type === 'purifier') {
      if (r.on === false) out.push({ id: d.id, command: 'power', args: { on: 'true' }, label: `${name}: on` });
      out.push({ id: d.id, command: 'setFan', args: { level: 2 }, label: `${name}: quiet clean` });
    } else if (d.type === 'tv' && prefs.tvWelcome && !prof && out.every(x => byType(x.id) !== 'tv')) {
      out.push({ id: d.id, command: 'setInput', args: { source: 'Apps' }, label: `${name}: welcome screen` });
    } else if (d.type === 'vacuum' && r.state === 'Cleaning') {
      out.push({ id: d.id, command: 'dock', args: {}, label: `${name}: back to its dock` });
    }
  }
  return out;
}
const byType = (id: string) => (DEV as any[]).find(d => d.id === id)?.type;

/** Run commands as one step list: each device's own commands in order, devices at the same time. */
async function runSteps(j: Journey, cmds: { id: string; command: string; args: Record<string, unknown>; label: string }[], by: string) {
  j.steps = cmds.map((c, i) => ({ key: `${i}`, label: c.label, status: 'pending', real: !!ST_PROFILE[c.id] }));
  bump();
  const groups = new Map<string, number[]>();
  cmds.forEach((c, i) => groups.set(c.id, [...(groups.get(c.id) ?? []), i]));
  await Promise.all([...groups.values()].map(async idx => {
    for (const i of idx) {
      const c = cmds[i], st = j.steps[i];
      st.status = 'running'; bump();
      let r: Result;
      try { r = await dispatch(c.id, c.command, c.args, false, by); } catch (e) { r = { ok: false, error: (e as Error).message }; }
      st.status = r.ok ? 'done' : 'failed'; st.via = r.via; if (!r.ok) st.detail = r.error; bump();
    }
  }));
}

/** Start pre-conditioning now. */
export async function prepare(token: string, why = 'arrival is near') {
  const j = journey(token);
  if (!j || j.state === 'departed' || j.state === 'preparing') return j;
  endEco(j.room, 'guest on the way');
  setTarget(j.room, j.prefs.temp);
  j.leadMin = leadMinutes(j);
  j.preparedAt = Date.now(); j.readyAt = null;
  mark(j, 'preparing', `Preparing the room (${why}): ${j.prefs.temp} °C, ${j.prefs.scene} light, curtain ${j.prefs.curtain} %`);
  await runSteps(j, welcomeScene(j.room, j.prefs), 'arrival');
  const failed = j.steps.filter(s => s.status === 'failed').length;
  if (failed) journal({ kind: 'arrival', room: j.room, guest: token, text: `${failed} welcome step(s) failed in ${j.roomName}: ${j.steps.filter(s => s.status === 'failed').map(s => `${s.label} (${s.detail})`).join('; ')}` });
  bump();
  return j;
}

/** The guest says they're on the way (minutes) — or the host sets the ETA. */
export function onMyWay(token: string, minutes: number, source: 'guest' | 'host' = 'guest') {
  const j = journey(token);
  if (!j || j.state === 'departed') return j;
  j.eta = Date.now() + clamp(minutes, 0, 24 * 60) * 60_000; j.etaSource = source; j.distanceM = null;
  if (j.state === 'booked' || j.state === 'away') mark(j, 'en_route', `On the way, about ${Math.round(minutes)} min`);
  else bump();
  return j;
}

/** The guest started the walk from the entrance (the 3D view knows the way and its length). */
export function walking(token: string, metres: number) {
  const j = journey(token);
  if (!j || j.state === 'departed' || j.state === 'arrived') return j;
  j.distanceM = round(metres, 0); j.eta = Date.now() + (metres / WALK_MPS) * 1000; j.etaSource = 'walk';
  if (j.state !== 'preparing' && j.state !== 'ready') mark(j, 'en_route', `Walking from the entrance, ${Math.round(metres)} m to go`);
  else bump();
  return j;
}

/** The guest reached the room. */
export function arrived(token: string, via = 'walk') {
  const j = journey(token);
  if (!j || j.state === 'arrived' || j.state === 'departed') return j;
  if (j.state === 'booked' || j.state === 'en_route' || j.state === 'away') void prepare(token, 'guest arrived before the room was prepared');
  j.arrivedAt = Date.now(); j.eta = null; j.distanceM = null;
  mark(j, 'arrived', `Arrived (${via})${j.readyAt ? `, room was ready ${Math.max(0, Math.round((j.arrivedAt - j.readyAt) / 60000))} min before` : ''}`);
  return j;
}

/** The guest stepped out: eco until they're on the way back. */
export async function away(token: string, why = 'guest stepped out') {
  const j = journey(token);
  if (!j || j.state === 'departed' || j.state === 'away') return j;
  mark(j, 'away', `Away (${why}): room set to eco`);
  await eco(j.room, why, false);
  return j;
}

/** Eco for a room: AC up to 27 °C (or off when nobody is staying), lights and TV off; curtain closed on checkout. */
export async function eco(room: string, reason: string, vacant: boolean) {
  startEco(room, reason);
  const devs = (DEV as any[]).filter(d => d.room === room);
  const snap = (id: string) => { try { return (device(id) as any)?.readings ?? {}; } catch { return {}; } };
  const cmds: [string, string, Record<string, unknown>][] = [];
  for (const d of devs) {
    const r = snap(d.id), prof = ST_PROFILE[d.id];
    if (d.type === 'ac' && r.on !== false) cmds.push(vacant ? [d.id, 'power', { on: 'false' }] : [d.id, 'setTemperature', { celsius: 27 }]);
    if (d.type === 'light' && num(r.lv, 0) > 0) cmds.push(prof?.kind === 'color' || !prof ? [d.id, 'setLevel', { percent: 0 }] : [d.id, 'power', { on: 'false' }]);
    if (d.type === 'tv' && r.on) cmds.push([d.id, 'power', { on: 'false' }]);
    if (d.type === 'fan' && r.on) cmds.push([d.id, 'power', { on: 'false' }]);
    if (d.type === 'purifier' && r.on !== false && num(r.fan, 1) > 1) cmds.push([d.id, 'setFan', { level: 1 }]);
    if (d.type === 'blinds' && vacant && num(r.pos, 0) > 0) cmds.push([d.id, 'setPosition', { percent: 0 }]);
  }
  const res = await Promise.all(cmds.map(([id, c, a]) => dispatch(id, c, a, false, 'eco').catch(e => ({ ok: false, error: String(e) }) as Result)));
  bump();
  return { commands: cmds.length, failed: res.filter(r => !r.ok).length };
}

/** Checkout: eco with the curtain closed, and housekeeping (the robot vacuum starts if the room has one). */
export async function checkout(token: string, by = 'host') {
  const p = passOf(token);
  const j = p ? journeyFor(p) : A.journeys[token];
  if (!j || j.state === 'departed') return j ?? null;
  j.departedAt = Date.now(); j.eta = null;
  mark(j, 'departed', `Checked out (${by}): room to eco, housekeeping requested`);
  setTarget(j.room, null);
  await eco(j.room, 'checked out', true);
  const vac = (DEV as any[]).find(d => d.room === j.room && d.type === 'vacuum');
  const hk: Housekeeping = { id: `hk-${Date.now().toString(36)}`, room: j.room, roomName: j.roomName, at: Date.now(), status: vac ? 'in_progress' : 'requested', items: ['Change linen and towels', 'Restock the minibar', 'Check every device works', ...(vac ? ['Robot vacuum cleaning the floor'] : ['Vacuum the floor'])], vacuum: vac?.id ?? null };
  A.housekeeping.push(hk); if (A.housekeeping.length > 50) A.housekeeping.shift();
  if (vac) await dispatch(vac.id, 'start', {}, false, 'housekeeping').catch(() => null);
  journal({ kind: 'housekeeping', room: j.room, text: `Housekeeping requested for ${j.roomName}${vac ? `; ${devName(vac.id)} started cleaning` : ''}` });
  bump();
  return j;
}

export function setHousekeeping(id: string, status: Housekeeping['status']) {
  const h = A.housekeeping.find(x => x.id === id);
  if (!h) return null;
  h.status = status; bump();
  journal({ kind: 'housekeeping', room: h.room, text: `Housekeeping in ${h.roomName}: ${status.replace('_', ' ')}` });
  return h;
}

export function setPrefs(token: string, p: Partial<Prefs>) {
  const j = journey(token);
  if (!j) return null;
  if (typeof p.temp === 'number') j.prefs.temp = clamp(Math.round(p.temp * 2) / 2, 18, 28);
  if (p.scene && ['warm', 'bright', 'calm', 'off'].includes(p.scene)) j.prefs.scene = p.scene;
  if (typeof p.curtain === 'number') j.prefs.curtain = clamp(Math.round(p.curtain / 10) * 10, 0, 100);
  if (typeof p.tvWelcome === 'boolean') j.prefs.tvWelcome = p.tvWelcome;
  if (j.state === 'preparing' || j.state === 'ready' || j.state === 'arrived') setTarget(j.room, j.prefs.temp);
  bump();
  return j;
}

/** Periodic step (experience loop, every 2 s): positioning ETAs, when to prepare, readiness, away, expiry. */
export async function tick() {
  for (const j of Object.values(A.journeys)) {
    if (j.state === 'departed') continue;
    const p = passOf(j.token);
    if (!p || p.revoked || Date.now() > p.expiresAt) { await checkout(j.token, p && Date.now() > p.expiresAt ? 'stay ended' : 'pass withdrawn'); continue; }
    // positioning: distance to the room gives an ETA; inside the room means arrived; outside long enough means away
    const fix = fixOf(j.token);
    if (fix && Date.now() - fix.at < 60_000) {
      const r = roomOf(j.room);
      const inRoom = r && insidePoly(polyOf(r), fix.x, fix.z);
      if (inRoom) { delete A.outside[j.token]; if (j.state !== 'arrived') arrived(j.token, 'positioning'); }
      else {
        const [cx, cz] = centroid(r);
        const d = Math.hypot(fix.x - cx, fix.z - cz) * 1.3;   // corridors are not straight lines
        if (j.state === 'arrived') { A.outside[j.token] ??= Date.now(); if (Date.now() - A.outside[j.token] > AWAY_MS) { delete A.outside[j.token]; await away(j.token, 'positioning shows the guest left the room'); } }
        else if (j.state !== 'away' || d < 40) {
          const was = j.state;
          j.distanceM = round(d, 0); j.eta = Date.now() + (d / WALK_MPS) * 1000; j.etaSource = 'position';
          if (was === 'booked' || was === 'away') mark(j, 'en_route', `Seen in the building, ${Math.round(d)} m away`);
        }
      }
    }
    // pre-condition in time for the ETA
    if (j.state === 'en_route' && j.eta) {
      const lead = leadMinutes(j);
      j.leadMin = lead;
      if (j.eta - Date.now() <= lead * 60_000) await prepare(j.token, `arriving in about ${Math.max(0, Math.round((j.eta - Date.now()) / 60000))} min`);
    }
    // ready when the steps are done and the room is at the guest's temperature
    if (j.state === 'preparing' && j.steps.every(s => s.status === 'done' || s.status === 'failed' || s.status === 'skipped')) {
      const c = roomComfort(j.room);
      if (!c || Math.abs(c.temp - j.prefs.temp) <= READY_BAND || (c && !(DEV as any[]).some(d => d.room === j.room && d.type === 'ac'))) {
        j.readyAt = Date.now();
        mark(j, 'ready', `Room ready: ${c ? `${c.temp} °C, comfort ${c.score}/100` : 'welcome scene set'}${j.preparedAt ? ` after ${Math.max(1, Math.round((j.readyAt - j.preparedAt) / 60000))} min` : ''}`);
      }
    }
  }
}

function insidePoly(P: [number, number][], x: number, z: number) {
  let c = false;
  for (let i = 0, k = P.length - 1; i < P.length; k = i++) {
    const [xi, zi] = P[i], [xk, zk] = P[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) c = !c;
  }
  return c;
}

/** What a guest's page shows about their journey (and the 3D view uses for the welcome). */
export function publicJourney(j: Journey | null) {
  if (!j) return null;
  const c = roomComfort(j.room);
  return {
    state: j.state, room: j.room, roomName: j.roomName, guest: j.guest, eta: j.eta, etaSource: j.etaSource, distanceM: j.distanceM, leadMin: j.leadMin,
    prefs: j.prefs, steps: j.steps, timeline: j.timeline.slice(-8), preparedAt: j.preparedAt, readyAt: j.readyAt, arrivedAt: j.arrivedAt, departedAt: j.departedAt,
    comfort: c ? { temp: c.temp, target: c.target, score: c.score, grade: c.grade, etaToTargetMin: c.etaToTargetMin, hum: c.hum } : null,
  };
}

// a pass withdrawn by the host checks the guest out
onCheckout((p, by) => { void checkout(p.token, by); });
