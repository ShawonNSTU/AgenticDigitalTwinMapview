// Live indoor positioning for guests. Position fixes come from three kinds of source, as a hotel would have them:
//   rtls        an indoor positioning system (UWB/BLE badges, e.g. a key-card tag) posts fixes to
//               /api/positioning/rtls with its key; a pass is bound to a badge by its tag id at check-in
//   checkpoint  the guest scans a location QR code on a wall (printed from /integrations); exact to ~1 m
//   pdr         the guest's phone counts steps and reads the compass between fixes (pedestrian dead reckoning);
//               the error grows with every step until the next fix
// The 3D view snaps fixes to walkable floor (map matching) and walks the guest's view there.
import { createHash, randomBytes } from 'node:crypto';
import { ROOMS } from './engine';
import { rt } from './runtime';

export type Fix = { x: number; z: number; accuracy: number; source: 'rtls' | 'checkpoint' | 'pdr' | 'rtls-sim'; at: number; heading?: number; checkpoint?: string };
type Config = { northDeg: number; stepLength: number; rtlsKey: string };

const g = globalThis as unknown as { __pos?: { fixes: Record<string, Fix>; config: Config; tags: Record<string, string> } };
const P = (g.__pos ??= { fixes: {}, config: { northDeg: 0, stepLength: 0.7, rtlsKey: process.env.RTLS_KEY ?? randomBytes(12).toString('base64url') }, tags: {} });

export const config = () => P.config;
export function setConfig(c: Partial<Pick<Config, 'northDeg' | 'stepLength'>>) {
  if (typeof c.northDeg === 'number') P.config.northDeg = ((c.northDeg % 360) + 360) % 360;
  if (typeof c.stepLength === 'number' && c.stepLength > 0.3 && c.stepLength < 1.2) P.config.stepLength = c.stepLength;
  return P.config;
}

/** Bind a badge/tag id of the hotel's positioning system to a guest pass (at check-in). */
export const bindTag = (tag: string, token: string) => { if (tag) P.tags[tag] = token; };
export const tokenForTag = (tag: string) => P.tags[tag] ?? null;

export function setFix(token: string, f: Omit<Fix, 'at'>) {
  P.fixes[token] = { ...f, x: +f.x.toFixed(2), z: +f.z.toFixed(2), accuracy: +Math.max(0.3, f.accuracy).toFixed(2), at: Date.now() };
  return P.fixes[token];
}
/** The guest's latest position if it is fresh (30 s). */
export function fixOf(token: string) {
  const f = P.fixes[token];
  return f && Date.now() - f.at < 30_000 ? f : null;
}

const polyOf = (r: any): [number, number][] => r.poly?.length >= 3 ? r.poly : [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]];
function inside(poly: [number, number][], x: number, z: number) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const roomAt = (x: number, z: number) => ROOMS.find((r: any) => inside(polyOf(r), x, z)) as any;
const name = (r: any) => r ? String(r.label ?? r.name).split('\n')[0] : 'Outside';

/** Location QR checkpoints: one on the corridor side of every door, and one in each stair, lift or lobby. */
export function checkpoints() {
  const out: { id: string; x: number; z: number; label: string; room: string }[] = [];
  for (const f of rt.furniture) {
    if (f.kind !== 'door') continue;
    const rot = f.rot ?? 0, n: [number, number] = [Math.sin(rot), Math.cos(rot)];
    const a = roomAt(f.x + n[0] * 0.6, f.z + n[1] * 0.6), b = roomAt(f.x - n[0] * 0.6, f.z - n[1] * 0.6);
    // stand on the side that is the corridor (or the bigger space), facing the door
    const sideA = a && /corridor|passage|lobby|hall/i.test(a.name), sideB = b && /corridor|passage|lobby|hall/i.test(b.name);
    const s = sideA ? 1 : sideB ? -1 : a ? 1 : -1;
    const room = s === 1 ? b : a, at = s === 1 ? a : b;
    if (!at) continue;
    const x = +(f.x + n[0] * 0.6 * s).toFixed(2), z = +(f.z + n[1] * 0.6 * s).toFixed(2);
    out.push({ id: createHash('sha1').update(`d${x},${z}`).digest('base64url').slice(0, 8), x, z, label: room ? `Door of ${name(room)}` : `Exit from ${name(at)}`, room: at.key });
  }
  for (const r of ROOMS as any[]) {
    if (!/stair|lift|elevator|lobby|reception/i.test(`${r.name} ${r.label ?? ''}`)) continue;
    const p = polyOf(r), x = +(p.reduce((s, q) => s + q[0], 0) / p.length).toFixed(2), z = +(p.reduce((s, q) => s + q[1], 0) / p.length).toFixed(2);
    out.push({ id: createHash('sha1').update(`r${r.key}`).digest('base64url').slice(0, 8), x, z, label: name(r), room: r.key });
  }
  return out;
}
export const checkpoint = (id: string) => checkpoints().find(c => c.id === id) ?? null;
