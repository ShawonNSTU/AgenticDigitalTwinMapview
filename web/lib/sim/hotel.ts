// Hotel set-up: turn a room of the floor into a guest room in one step. The room is refurnished (bed against
// the longest wall without a door, nightstands, desk and armchair facing the TV wall) and fitted with the
// devices a hotel room has: AC, TV, ceiling and reading lights, blinds on the outside wall, minibar fridge,
// fan, air purifier, robot vacuum, a door lock beside the door and a temperature/humidity sensor.
// Positions are worked out from the room outline, its doors and which walls face outside.
import { ROOMS, DEV, LAYOUT } from './engine';
import { rt, addDevice, removeDevice } from './runtime';
import { insideXZ } from '@/lib/layout';
import { log as journal } from '@/lib/kg/journal';

type V = [number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k];
const len = (a: V) => Math.hypot(a[0], a[1]);
const norm = (a: V): V => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

const polyOf = (r: any): V[] => r.poly?.length >= 3 ? r.poly : [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]];
const inRoom = (r: any, p: V) => insideXZ(polyOf(r), p[0], p[1]);
const inAnyRoom = (p: V) => ROOMS.some((r: any) => inRoom(r, p));

type Wall = { a: V; b: V; u: V; n: V; len: number; mid: V; outside: boolean; doors: number[] };

/** The room's walls with the inward normal, whether they face outside, and door positions along them. */
export function walls(r: any): Wall[] {
  const P = polyOf(r);
  const doors = rt.furniture.filter(f => f.kind === 'door');
  const out: Wall[] = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i] as V, b = P[(i + 1) % P.length] as V;
    const L = len(sub(b, a));
    if (L < 0.8) continue;
    const u = norm(sub(b, a));
    let n: V = [-u[1], u[0]];
    const mid = mul(add(a, b), 0.5);
    if (!inRoom(r, add(mid, mul(n, 0.3)))) n = [-n[0], -n[1]];
    const ds: number[] = [];
    for (const d of doors) {
      const rel = sub([d.x, d.z], a);
      const t = rel[0] * u[0] + rel[1] * u[1];
      const off = Math.abs(rel[0] * n[0] + rel[1] * n[1]);
      if (t > -0.3 && t < L + 0.3 && off < 0.3) ds.push(t);
    }
    out.push({ a, b, u, n, len: L, mid, outside: !inAnyRoom(add(mid, mul(n, -0.4))), doors: ds });
  }
  return out;
}

/** A spot along a wall (t metres from its start), `inset` metres into the room. */
const along = (w: Wall, t: number, inset: number): V => add(add(w.a, mul(w.u, t)), mul(w.n, inset));
/** rotationY for a device facing into the room from wall w (rotationY 0 faces +z). */
const facing = (w: Wall) => Math.atan2(w.n[0], w.n[1]);
/** Furniture rot whose width runs along wall w ((cos rot, -sin rot) is the width axis). */
const rotAlong = (w: Wall) => Math.atan2(-w.u[1], w.u[0]);
/** Free stretch of a wall around t (no door within `half` metres). */
const clear = (w: Wall, t: number, half: number) => t - half > 0.15 && t + half < w.len - 0.15 && w.doors.every(d => Math.abs(d - t) > half + 0.55);
function freeT(w: Wall, half: number, prefer = 0.5): number | null {
  const cands: number[] = [];
  for (let t = half + 0.2; t <= w.len - half - 0.2; t += 0.2) if (clear(w, t, half)) cands.push(t);
  if (!cands.length) return null;
  return cands.sort((x, y) => Math.abs(x - w.len * prefer) - Math.abs(y - w.len * prefer))[0];
}

/** Whether a person (0.25 m radius) can reach almost all of the room's floor from its doors. */
export function walkable(P: V[], furn: { x: number; z: number; w: number; d: number; rot?: number }[], doors: V[]) {
  if (!doors.length) return true;
  const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
  const x0 = Math.min(...xs), z0 = Math.min(...zs), c = 0.15;
  const nx = Math.ceil((Math.max(...xs) - x0) / c), nz = Math.ceil((Math.max(...zs) - z0) / c);
  const R = 0.25;
  const segDist = (p: V, a: V, b: V) => { const e = sub(b, a), l2 = e[0] * e[0] + e[1] * e[1]; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * e[0] + (p[1] - a[1]) * e[1]) / l2)) : 0; return len(sub(p, add(a, mul(e, t)))); };
  const inRect = (p: V, f: { x: number; z: number; w: number; d: number; rot?: number }) => {
    const r = f.rot ?? 0, u: V = [Math.cos(r), -Math.sin(r)], v: V = [Math.sin(r), Math.cos(r)], q = sub(p, [f.x, f.z]);
    return Math.abs(q[0] * u[0] + q[1] * u[1]) <= f.w / 2 + R && Math.abs(q[0] * v[0] + q[1] * v[1]) <= f.d / 2 + R;
  };
  const free = (i: number, j: number) => {
    const p: V = [x0 + (i + 0.5) * c, z0 + (j + 0.5) * c];
    if (!insideXZ(P as any, p[0], p[1])) return false;
    for (let k = 0; k < P.length; k++) if (segDist(p, P[k], P[(k + 1) % P.length]) < R) return false;
    return !furn.some(f => inRect(p, f));
  };
  const ok: boolean[] = [];
  let total = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const f = free(i, j); ok.push(f); if (f) total++; }
  const seen = new Uint8Array(nx * nz), queue: number[] = [];
  for (const d of doors) {
    // the free cells just inside each door
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p: V = [x0 + (i + 0.5) * c, z0 + (j + 0.5) * c];
      if (ok[j * nx + i] && len(sub(p, d)) < 0.75 && !seen[j * nx + i]) { seen[j * nx + i] = 1; queue.push(j * nx + i); }
    }
  }
  let reached = queue.length;
  while (queue.length) {
    const k = queue.pop()!, i = k % nx, j = Math.floor(k / nx);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const kk = b * nx + a;
      if (ok[kk] && !seen[kk]) { seen[kk] = 1; reached++; queue.push(kk); }
    }
  }
  return total === 0 || reached / total >= 0.9;
}

export const GUEST_KIT = ['ac', 'tv', 'light', 'light', 'blinds', 'fridge', 'fan', 'purifier', 'vacuum', 'lock', 'temphum'];

/** Rooms that make sense as guest rooms: not corridors, stairs, toilets, plant or store rooms, and big enough. */
export function guestRoomCandidates() {
  const skip = /corridor|passage|stair|lift|toilet|wash|ablution|bath|pray|store|hub|utility|a\/?c|outdoor|plant|dressing|server|electric|cafeteria|gym|lobby|reception/i;
  return ROOMS.filter((r: any) => {
    if (r.finish) return false; // already fitted with its SmartThings devices (the SmartThings Experience Zone)
    const P = polyOf(r);
    const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
    return !skip.test(`${r.name} ${r.label ?? ''}`) && Math.min(w, d) >= 2.8 && w * d >= 10 && w * d <= 200;
  }).map((r: any) => ({ key: r.key, name: String(r.label ?? r.name).split('\n')[0] }));
}

/** Refurnish one room as a guest room and fit its devices. Replaces the room's furniture and devices. */
export function setUpGuestRoom(key: string) {
  const r = ROOMS.find((x: any) => x.key === key);
  if (!r) return { ok: false as const, error: `Unknown room ${key}` };
  if ((r as any).finish) return { ok: false as const, error: 'This room already has its SmartThings devices installed; make a guest QR for it directly' };
  const W = walls(r);
  if (W.length < 3) return { ok: false as const, error: 'This room outline is too irregular to furnish automatically' };
  const P = polyOf(r);
  const centre: V = mul(P.reduce((s, p) => add(s, p as V), [0, 0] as V), 1 / P.length);

  // 1. clear the room (doors stay)
  rt.furniture = rt.furniture.filter(f => f.kind === 'door' || !inRoom(r, [f.x, f.z]));
  for (const d of DEV.filter((d: any) => d.room === key)) removeDevice(d.id);

  // nothing may stand in front of a door: keep 1.2 m around each door of the room clear to walk in
  const doorPts: V[] = rt.furniture.filter(f => f.kind === 'door').map(f => [f.x, f.z] as V)
    .filter(p => W.some(w => { const rel = sub(p, w.a); const t = rel[0] * w.u[0] + rel[1] * w.u[1]; return t > -0.3 && t < w.len + 0.3 && Math.abs(rel[0] * w.n[0] + rel[1] * w.n[1]) < 0.3; }));
  // how far the room reaches from point p in direction n (to the first wall)
  const reach = (p: V, n: V) => {
    let best = Infinity;
    for (let i = 0; i < P.length; i++) {
      const a = P[i] as V, b = P[(i + 1) % P.length] as V, e = sub(b, a);
      const den = n[0] * e[1] - n[1] * e[0];
      if (Math.abs(den) < 1e-9) continue;
      const ap = sub(a, p);
      const t = (ap[0] * e[1] - ap[1] * e[0]) / den, u = (ap[0] * n[1] - ap[1] * n[0]) / den;
      if (t > 0.05 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return best;
  };
  // a piece against wall w at t, `d` deep, must leave a 0.9 m way past it to the far wall
  const leavesWay = (w: Wall, t: number, d: number, half: number) => [-half, 0, half].every(o => reach(along(w, t + o, 0.02), w.n) - d >= 0.9);
  const clearOfDoors = (p: V, w: number, d: number) => doorPts.every(q => len(sub(p, q)) - Math.hypot(w, d) / 2 > 1.2);

  // 2. bed against the longest wall with room for it (clear of the door); TV on the wall facing the bed
  const depth = Math.min(2.0, Math.max(...W.map(w => w.len)) * 0.45);
  const byLen = [...W].sort((a, b) => b.len - a.len);
  let bedWall = byLen[0], bt = byLen[0].len / 2;
  search: for (const w of byLen) {
    for (let t = 1.05; t <= w.len - 1.05; t += 0.2) if (clear(w, t, 1.0) && clearOfDoors(along(w, t, depth / 2 + 0.05), 1.6, depth) && leavesWay(w, t, depth + 0.05, 0.8)) { bedWall = w; bt = t; break search; }
  }
  const furn: typeof rt.furniture = [];
  const put = (kind: string, p: V, w: number, d: number, rot: number) => { if (kind === 'bed' || clearOfDoors(p, w, d)) furn.push({ kind, x: +p[0].toFixed(3), z: +p[1].toFixed(3), w, d, rot: +rot.toFixed(4) }); };
  const bedOk = leavesWay(bedWall, bt, depth + 0.05, 0.8) && clearOfDoors(along(bedWall, bt, depth / 2 + 0.05), 1.6, depth);
  if (bedOk) put('bed', along(bedWall, bt, depth / 2 + 0.05), 1.6, depth, rotAlong(bedWall));
  for (const s of [-1, 1]) {
    const t = bt + s * 1.15;
    if (bedOk && t > 0.35 && t < bedWall.len - 0.35 && clear(bedWall, t, 0.25) && leavesWay(bedWall, t, 0.45, 0.2)) put('cabinet', along(bedWall, t, 0.25), 0.45, 0.4, rotAlong(bedWall));
  }
  const opposite = W.filter(w => w !== bedWall).sort((a, b) => (a.n[0] * bedWall.n[0] + a.n[1] * bedWall.n[1]) - (b.n[0] * bedWall.n[0] + b.n[1] * bedWall.n[1]))[0];
  const side = W.filter(w => w !== bedWall && w !== opposite).sort((a, b) => b.len - a.len);
  const win = W.filter(w => w.outside).sort((a, b) => b.len - a.len)[0] ?? side[0] ?? opposite;
  const tvT = freeT(opposite, 0.7) ?? opposite.len / 2;
  const deskT = freeT(opposite, 0.6, 0.2);
  if (deskT != null && Math.abs(deskT - tvT) > 1.4 && leavesWay(opposite, deskT, 0.6, 0.6)) put('desk', along(opposite, deskT, 0.3), 1.2, 0.55, rotAlong(opposite));
  const chairWall = win !== bedWall ? win : side[0];
  if (chairWall) { const t = freeT(chairWall, 0.45, 0.25); if (t != null && leavesWay(chairWall, t, 0.95, 0.4)) put('armchair', along(chairWall, t, 0.55), 0.8, 0.8, rotAlong(chairWall)); }
  // the room must stay walkable from its door: drop pieces (armchair, desk, nightstands, then the bed) until
  // nearly all of the floor can be reached from the doorway
  const order = ['armchair', 'desk', 'cabinet', 'cabinet', 'bed'];
  while (furn.length && !walkable(P, furn, doorPts)) {
    const k = order.find(kind => furn.some(f => f.kind === kind));
    if (!k) break;
    furn.splice(furn.findIndex(f => f.kind === k), 1);
  }
  rt.furniture = [...rt.furniture, ...furn];

  // 3. devices
  const made: string[] = [];
  const dev = (type: string, p: V, rot: number, name?: string) => { const x = addDevice({ type, x: p[0], z: p[1], rotationY: rot, room: key, name }); if (x.ok) made.push(x.device.id); };
  const acWall = side[0] ?? opposite;
  dev('ac', along(acWall, freeT(acWall, 0.5) ?? acWall.len / 2, 0.14), facing(acWall));
  dev('tv', along(opposite, tvT, 0.06), facing(opposite));
  dev('light', centre, 0, 'Ceiling light');
  dev('light', along(bedWall, bt, 0.9), 0, 'Reading light');
  dev('blinds', along(win, freeT(win, 0.55) ?? win.len / 2, 0.08), facing(win));
  const fz = freeT(opposite, 0.4, 0.92);
  if (fz != null && Math.abs(fz - tvT) > 1.0) dev('fridge', along(opposite, fz, 0.4), facing(opposite), 'Minibar');
  const corner = (w: Wall, end: number, inset: number): V => along(w, end === 0 ? 0.6 : w.len - 0.6, inset);
  dev('fan', corner(bedWall, bt > bedWall.len / 2 ? 0 : 1, 0.7), facing(bedWall));
  dev('purifier', corner(opposite, 1, 0.45), facing(opposite));
  dev('vacuum', corner(acWall, 0, 0.35), facing(acWall));
  const doorWall = W.find(w => w.doors.length) ;
  if (doorWall) {
    const dt = doorWall.doors[0];
    const t = dt + 0.75 < doorWall.len - 0.1 ? dt + 0.75 : dt - 0.75;
    dev('lock', along(doorWall, t, 0.06), facing(doorWall), 'Door lock');
    dev('temphum', along(doorWall, t + (t > dt ? 0.4 : -0.4), 0.04), facing(doorWall));
  }
  LAYOUT.version++; // the furniture changed: renderers reload the layout
  journal({ kind: 'floor', room: key, text: `${String((r as any).name)} set up as a guest room: ${furn.length} furniture items, ${Array.isArray(made) ? made.length : made} SmartThings devices` });
  return { ok: true as const, room: key, furniture: furn.length, devices: made };
}

/** Set up several rooms (default: every candidate) as guest rooms. */
export function setUpHotel(keys?: string[]) {
  const list = keys?.length ? keys : guestRoomCandidates().map(r => r.key);
  const done = list.map(k => setUpGuestRoom(k));
  // the ACs need an outdoor unit: in the plant / AC room if the floor has one, else on the outdoor pad
  if (!DEV.some((d: any) => d.type === 'odu')) {
    const plant = ROOMS.find((r: any) => /outdoor|a\/?c room|plant/i.test(`${r.name} ${r.label ?? ''}`));
    const at: V = plant ? mul(polyOf(plant).reduce((s, p) => add(s, p as V), [0, 0] as V), 1 / polyOf(plant).length) : [LAYOUT.outdoorPad?.x ?? 0, LAYOUT.outdoorPad?.z ?? 0];
    addDevice({ type: 'odu', x: at[0], z: at[1], room: plant?.key });
  }
  rt.title = rt.title.replace(/^(Hotel · )?/, 'Hotel · ');
  return { ok: true, rooms: done.filter(d => d.ok).length, results: done };
}

// ---- the host adds, moves, turns and removes furniture in a room ------------------------------------------------

/** Furniture the host can add, with its footprint (width along the wall, depth) and whether it stands against a wall. */
export const FURNITURE: Record<string, { label: string; w: number; d: number; wall: boolean; set?: { kind: string; dx: number; dz: number; w: number; d: number; rot: number }[] }> = {
  bed: { label: 'Bed', w: 1.6, d: 2.0, wall: true },
  cabinet: { label: 'Nightstand / cabinet', w: 0.6, d: 0.45, wall: true },
  desk: { label: 'Desk', w: 1.2, d: 0.6, wall: true },
  sofa: { label: 'Sofa', w: 2.0, d: 0.9, wall: true },
  armchair: { label: 'Armchair', w: 0.8, d: 0.8, wall: false },
  shelf: { label: 'Wardrobe / shelf', w: 1.0, d: 0.55, wall: true },
  table: { label: 'Table', w: 1.2, d: 0.8, wall: false },
  chair: { label: 'Chair', w: 0.5, d: 0.5, wall: false },
  dining: { label: 'Dining set (table and 4 chairs)', w: 2.0, d: 1.9, wall: false, set: [
    { kind: 'table', dx: 0, dz: 0, w: 1.2, d: 0.8, rot: 0 },
    { kind: 'chair', dx: -0.3, dz: -0.68, w: 0.45, d: 0.45, rot: 0 }, { kind: 'chair', dx: 0.3, dz: -0.68, w: 0.45, d: 0.45, rot: 0 },
    { kind: 'chair', dx: -0.3, dz: 0.68, w: 0.45, d: 0.45, rot: Math.PI }, { kind: 'chair', dx: 0.3, dz: 0.68, w: 0.45, d: 0.45, rot: Math.PI }] },
  plant: { label: 'Plant', w: 0.45, d: 0.45, wall: false },
};

type F = (typeof rt.furniture)[number] & { id?: string; group?: string };
let nextId = 1;
const ids = () => { for (const f of rt.furniture as F[]) f.id ??= `f${nextId++}`; return rt.furniture as F[]; };
const rectPts = (f: { x: number; z: number; w: number; d: number; rot?: number }, grow = 0): V[] => {
  const r = f.rot ?? 0, u: V = [Math.cos(r), -Math.sin(r)], v: V = [Math.sin(r), Math.cos(r)], hw = f.w / 2 + grow, hd = f.d / 2 + grow;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => [f.x + u[0] * a + v[0] * b, f.z + u[1] * a + v[1] * b] as V);
};
function overlaps(a: V[], b: V[]) {
  // separating axis test for two rectangles
  for (const poly of [a, b]) for (let i = 0; i < 4; i++) {
    const e = sub(poly[(i + 1) % 4], poly[i]), n: V = [-e[1], e[0]];
    const pa = a.map(p => p[0] * n[0] + p[1] * n[1]), pb = b.map(p => p[0] * n[0] + p[1] * n[1]);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

export function roomFurniture(key: string) {
  const r = ROOMS.find((x: any) => x.key === key);
  if (!r) return [];
  return ids().filter(f => f.kind !== 'door' && inRoom(r, [f.x, f.z])).map(f => ({ id: f.id!, kind: f.kind, group: f.group, x: f.x, z: f.z, w: f.w, d: f.d, rot: f.rot ?? 0, label: FURNITURE[f.kind]?.label ?? f.kind }));
}

/** Pieces as placed (a dining set is a table with chairs around it). */
function pieces(kind: string, x: number, z: number, rot: number, group: string): F[] {
  const spec = FURNITURE[kind];
  if (!spec.set) return [{ kind, x, z, w: spec.w, d: spec.d, rot, group } as F];
  const u: V = [Math.cos(rot), -Math.sin(rot)], v: V = [Math.sin(rot), Math.cos(rot)];
  return spec.set.map(p => ({ kind: p.kind, x: +(x + u[0] * p.dx + v[0] * p.dz).toFixed(3), z: +(z + u[1] * p.dx + v[1] * p.dz).toFixed(3), w: p.w, d: p.d, rot: +(rot + p.rot).toFixed(4), group } as F));
}

/** Whether pieces fit: inside the room, clear of walls, other furniture and doors, and the room stays walkable. */
function fits(r: any, add: F[], ignore: Set<string>) {
  const P = polyOf(r);
  const others = ids().filter(f => f.kind !== 'door' && inRoom(r, [f.x, f.z]) && !ignore.has(f.id!));
  for (const f of add) {
    const pts = rectPts(f);
    if (!pts.every(p => inRoom(r, p))) return false;
    if (others.some(o => overlaps(rectPts(f, 0.03), rectPts(o)))) return false;
  }
  const doors: V[] = rt.furniture.filter(f => f.kind === 'door').map(f => [f.x, f.z] as V).filter(p => P.some((a, i) => { const b = P[(i + 1) % P.length] as V; const e = sub(b, a as V); const l2 = e[0] ** 2 + e[1] ** 2; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * e[0] + (p[1] - a[1]) * e[1]) / l2)); return len(sub(p, add2(a as V, mul(e, t)))) < 0.3; }));
  if (add.some(f => doors.some(q => len(sub([f.x, f.z], q)) - Math.hypot(f.w, f.d) / 2 < 0.9))) return false;
  return walkable(P as V[], [...others, ...add], doors);
}
const add2 = add;

/** Adds furniture to a room at the best free spot (against a wall when it belongs there). */
export function addFurniture(key: string, kind: string) {
  const r = ROOMS.find((x: any) => x.key === key);
  const spec = FURNITURE[kind];
  if (!r) return { ok: false as const, error: `Unknown room ${key}` };
  if (!spec) return { ok: false as const, error: `Unknown furniture ${kind}` };
  const group = `g${nextId++}`;
  const cands: { x: number; z: number; rot: number; score: number }[] = [];
  const P = polyOf(r);
  const c: V = mul(P.reduce((s, p) => add(s, p as V), [0, 0] as V), 1 / P.length);
  if (spec.wall) {
    for (const w of walls(r)) for (let t = spec.w / 2 + 0.1; t <= w.len - spec.w / 2 - 0.1; t += 0.25) {
      const p = along(w, t, spec.d / 2 + 0.03);
      cands.push({ x: p[0], z: p[1], rot: rotAlong(w), score: len(sub(p, c)) * 0.2 - w.len * 0.05 });
    }
  } else {
    const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
    for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs); x += 0.3) for (let z = Math.min(...zs) + 0.5; z < Math.max(...zs); z += 0.3)
      if (inRoom(r, [x, z])) cands.push({ x, z, rot: 0, score: len(sub([x, z], c)) });
  }
  cands.sort((a, b) => a.score - b.score);
  for (const k of cands.slice(0, 400)) {
    const ps = pieces(kind, +k.x.toFixed(3), +k.z.toFixed(3), +k.rot.toFixed(4), group);
    if (fits(r, ps, new Set())) {
      for (const p of ps) p.id = `f${nextId++}`;
      rt.furniture.push(...ps);
      LAYOUT.version++;
      journal({ kind: 'floor', room: key, text: `${spec.label} added to ${String((r as any).name)}` });
      return { ok: true as const, added: ps.map(p => p.id!) };
    }
  }
  return { ok: false as const, error: `No free spot for a ${spec.label.toLowerCase()} in this room that keeps it walkable` };
}

/** Moves (dx, dz metres) or turns (degrees) a piece, with the rest of its set; refused if it would not fit. */
export function editFurniture(id: string, op: { dx?: number; dz?: number; turn?: number; remove?: boolean }) {
  const all = ids();
  const f = all.find(x => x.id === id);
  if (!f) return { ok: false as const, error: 'Unknown furniture' };
  const set = f.group ? all.filter(x => x.group === f.group) : [f];
  if (op.remove) { rt.furniture = all.filter(x => !set.includes(x)); LAYOUT.version++; return { ok: true as const }; }
  const r = ROOMS.find((x: any) => inRoom(x, [f.x, f.z]));
  const a = ((op.turn ?? 0) * Math.PI) / 180, cx = set.reduce((s, x) => s + x.x, 0) / set.length, cz = set.reduce((s, x) => s + x.z, 0) / set.length;
  const moved = set.map(x => {
    const rx = x.x - cx, rz = x.z - cz;
    return { ...x, x: +(cx + rx * Math.cos(a) + rz * Math.sin(a) + (op.dx ?? 0)).toFixed(3), z: +(cz - rx * Math.sin(a) + rz * Math.cos(a) + (op.dz ?? 0)).toFixed(3), rot: +(((x.rot ?? 0) + a)).toFixed(4) };
  });
  if (r && !fits(r, moved, new Set(set.map(x => x.id!)))) return { ok: false as const, error: 'It would block the way, hit a wall or overlap other furniture there' };
  for (const [i, x] of set.entries()) Object.assign(x, moved[i]);
  LAYOUT.version++;
  return { ok: true as const };
}
