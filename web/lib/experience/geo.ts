// Small geometry and naming helpers shared by the experience services (energy, comfort, arrival, predictions).
import { ROOMS, byId } from '@/lib/sim/engine';

export type V = [number, number];

export const polyOf = (r: any): V[] => r?.poly?.length >= 3 ? r.poly : r ? [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]] : [];

/** Floor area in m² (shoelace). */
export function area(r: any): number {
  const P = polyOf(r);
  let a = 0;
  for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; a += x0 * z1 - x1 * z0; }
  return Math.abs(a) / 2;
}

export function centroid(r: any): V {
  const P = polyOf(r);
  if (!P.length) return [0, 0];
  return [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
}

export const roomOf = (key: string) => (ROOMS as any[]).find(r => r.key === key) ?? null;
export const roomName = (key: string) => { const r = roomOf(key); return r ? String(r.label ?? r.name ?? key).split('\n')[0] : key === 'out' ? 'Outside' : key; };
export const devName = (id: string) => String(byId[id]?.name ?? id).split(' · ')[0];
export const posOf = (id: string): V => { const p = byId[id]?.p; return Array.isArray(p) ? [Number(p[0]), Number(p[2])] : [0, 0]; };

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
export const round = (v: number, dp = 1) => { const k = 10 ** dp; return Math.round(v * k) / k; };

/** Hour of day on the server's clock (real time, not the simulator's clock). */
export const hourNow = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
