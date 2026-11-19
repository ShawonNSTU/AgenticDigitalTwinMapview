// Helpers for turning an uploaded floor plan (image coordinates 0..1) into a 3D layout (metres).
import types from '@/lib/sim/data/device_types.json';

export const DEVICE_TYPES = Object.entries(types as Record<string, { label: string }>).map(([key, t]) => ({ key, label: t.label }));

export const PREFIX: Record<string, string> = { ac: 'AC', odu: 'ODU', light: 'LT', tv: 'TV', speaker: 'SP', blinds: 'BL', fridge: 'FR', oven: 'OV', vacuum: 'VC', camera: 'CM', doorbell: 'DB', lock: 'DL', leak: 'LK', washer: 'WA', dryer: 'DR', temphum: 'TH', motion: 'MS', plug: 'PL', purifier: 'AP' };

/** Mount height in metres per type (same as the sample home). */
export const MOUNT: Record<string, number> = { ac: 2.15, odu: 0, light: 2.6, tv: 1.2, speaker: 0.55, blinds: 1.7, fridge: 0.9, oven: 0.45, vacuum: 0.06, camera: 2.2, doorbell: 1.3, lock: 1, washer: 0.45, dryer: 0.45, leak: 0.02, temphum: 1.5, motion: 2.2, plug: 0.35, purifier: 0.3 };

const COLORS = ['#8fb4f2', '#a8d8a0', '#c7b7ef', '#f2dc8f', '#8fd8d0', '#f2b8c6', '#c3e6a4', '#9fd0f0', '#94b8e8', '#a6e3c8'];

/** A room is a polygon in image fractions (x right, y down). Rectangles are just 4-point polygons. */
export type Pt = [number, number];
export type PlanRoom = { key: string; name: string; pts: Pt[]; color: string; label?: string; labelAt?: Pt; zone?: string };
/** Interior item: centre in image fractions, size (w across, d front-to-back) as fractions of image width, rot = facing in radians (0 faces down the image). */
export type PlanFurniture = { kind: string; fx: number; fy: number; fw: number; fd: number; rot: number };
export const FURNITURE_KINDS = ['column', 'chair', 'task_chair', 'table', 'round_table', 'desk', 'workstation', 'sofa', 'armchair', 'bed', 'cabinet', 'shelf', 'rack', 'counter', 'sink', 'toilet', 'shower', 'stair', 'screen', 'railing', 'treadmill', 'bike', 'weight_rack', 'door', 'plant', 'locker', 'bench', 'stool', 'dispenser', 'vending', 'elec_panel'] as const;
export type PlanNote = { text: string; fx: number; fy: number; size?: number; rot?: number };

export type PlanDevice = { id: string; type: string; fx: number; fy: number; name?: string; assumed?: boolean };

export const roomColor = (i: number) => COLORS[i % COLORS.length];

export function roomKey(name: string, taken: Set<string>) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';
  let k = base, i = 2;
  while (taken.has(k)) k = `${base}-${i++}`;
  return k;
}

export function nextId(type: string, devices: PlanDevice[]) {
  const p = PREFIX[type] ?? type.slice(0, 2).toUpperCase();
  let n = 1;
  while (devices.some(d => d.id === `${p}-${String(n).padStart(2, '0')}`)) n++;
  return `${p}-${String(n).padStart(2, '0')}`;
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export function bbox(pts: Pt[]) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Even-odd ray casting; works for any simple polygon, convex or not. */
export function inside(pts: Pt[], x: number, y: number) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function distToEdges(pts: Pt[], x: number, y: number) {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}

/** The point deepest inside the polygon (grid search). Used for labels and for facing devices into the room. */
export function interior(pts: Pt[]): Pt {
  const b = bbox(pts); let best: Pt = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], bd = -1;
  for (let i = 1; i < 24; i++) for (let j = 1; j < 24; j++) {
    const x = b.x0 + (b.x1 - b.x0) * i / 24, y = b.y0 + (b.y1 - b.y0) * j / 24;
    if (inside(pts, x, y)) { const d = distToEdges(pts, x, y); if (d > bd) { bd = d; best = [x, y]; } }
  }
  return best;
}

/** Move a point into the polygon (towards its interior point) if it falls outside, e.g. in the notch of an L-shaped room. */
export function pullInside(pts: Pt[], x: number, y: number): Pt {
  if (inside(pts, x, y)) return [x, y];
  const [cx, cy] = interior(pts);
  for (let t = 0.05; t <= 1; t += 0.05) { const px = x + (cx - x) * t, py = y + (cy - y) * t; if (inside(pts, px, py) && distToEdges(pts, px, py) > 0.004) return [px, py]; }
  return [cx, cy];
}

/** Point-in-polygon in metres (x, z), for rooms of the 3D layout. */
export function insideXZ(poly: [number, number][], x: number, z: number) { return inside(poly as Pt[], x, z); }

export function roomAt(rooms: PlanRoom[], fx: number, fy: number) {
  return rooms.find(r => inside(r.pts, fx, fy)) ?? null;
}

/** Typical devices for a room, from its name. Slots are positions inside the room (fractions of the room). */
const TYPICAL: [RegExp, string[]][] = [
  [/kitchen/i, ['ac', 'light', 'fridge', 'oven']],
  [/living|family|lounge|great/i, ['ac', 'light', 'tv', 'speaker']],
  [/bed|master|primary|guest/i, ['ac', 'light', 'blinds', 'motion']],
  [/dining/i, ['ac', 'light']],
  [/laundry|utility/i, ['washer', 'dryer', 'leak', 'light']],
  [/bath|toilet|wc|shower|powder/i, ['light', 'leak', 'temphum']],
  [/media|study|office|den/i, ['ac', 'light', 'plug']],
  [/porch|entry|foyer|hall/i, ['lock', 'doorbell', 'camera', 'light']],
  [/balcony|deck|terrace|patio|garden/i, ['camera']],
  [/garage/i, ['light', 'camera']],
];
const SLOTS: Record<string, [number, number]> = { ac: [0.5, 0.06], light: [0.5, 0.5], tv: [0.06, 0.5], speaker: [0.15, 0.8], fridge: [0.85, 0.15], oven: [0.65, 0.12], blinds: [0.5, 0.95], motion: [0.92, 0.08], washer: [0.25, 0.2], dryer: [0.6, 0.2], leak: [0.25, 0.4], temphum: [0.92, 0.5], plug: [0.85, 0.85], lock: [0.5, 0.94], doorbell: [0.6, 0.94], camera: [0.08, 0.08], purifier: [0.85, 0.75], vacuum: [0.3, 0.7] };

export function autoPlace(rooms: PlanRoom[], keep: PlanDevice[], outdoor: { x: number; y: number } | null) {
  const out = [...keep];
  for (const r of rooms) {
    const want = TYPICAL.find(([re]) => re.test(r.name))?.[1] ?? ['light'];
    for (const type of want) {
      const [sx, sy] = SLOTS[type] ?? [0.5, 0.5];
      const b = bbox(r.pts);
      const [fx, fy] = pullInside(r.pts, b.x0 + (b.x1 - b.x0) * sx, b.y0 + (b.y1 - b.y0) * sy);
      out.push({ id: nextId(type, out), type, fx, fy });
    }
  }
  if (!out.some(d => d.type === 'odu') && out.some(d => d.type === 'ac')) {
    const minY = Math.min(...rooms.map(r => bbox(r.pts).y0));
    out.push({ id: nextId('odu', out), type: 'odu', fx: outdoor?.x ?? 0.5, fy: outdoor?.y ?? minY - 0.05 });
  }
  return out;
}

/** Convert the editor state to the POST /api/building body. widthM is the real width of the image in metres. */
export function toBuilding(rooms: PlanRoom[], devices: PlanDevice[], widthM: number, aspect: number, dataUrl: string, furniture: PlanFurniture[] = [], notes: PlanNote[] = []) {
  const W = widthM, H = widthM * aspect;
  const X = (f: number) => +((f - 0.5) * W).toFixed(3), Z = (f: number) => +((f - 0.5) * H).toFixed(3);
  return {
    rooms: rooms.map(r => { const b = bbox(r.pts); return { key: r.key, name: r.name, x: [X(b.x0), X(b.x1)], z: [Z(b.y0), Z(b.y1)], poly: r.pts.map(([x, y]) => [X(x), Z(y)]), color: r.color,
      ...(r.label ? { label: r.label } : {}), ...(r.labelAt ? { labelAt: [X(r.labelAt[0]), Z(r.labelAt[1])] } : {}), ...(r.zone ? { zone: r.zone } : {}) }; }),
    devices: devices.map(d => {
      const r = roomAt(rooms, d.fx, d.fy);
      const x = X(d.fx), z = Z(d.fy);
      // Face the device towards the deepest point of its room (rotationY 0 faces +z).
      const c = r ? interior(r.pts) : null;
      const rot = c ? Math.atan2(X(c[0]) - x, Z(c[1]) - z) : 0;
      const label = DEVICE_TYPES.find(t => t.key === d.type)?.label ?? d.type;
      return { id: d.id, type: d.type, room: r?.key ?? 'out', name: `${d.name ?? label} · ${r?.name ?? 'Outside'}${d.assumed ? ' (position assumed)' : ''}`, position: [x, MOUNT[d.type] ?? 1, z], rotationY: +rot.toFixed(4) };
    }),
    // rot in the image: 0 faces down = +z in the scene, so it carries over unchanged
    furniture: furniture.map(f => ({ kind: f.kind, x: X(f.fx), z: Z(f.fy), w: +(f.fw * W).toFixed(3), d: +(f.fd * W).toFixed(3), rot: +f.rot.toFixed(4) })),
    notes: notes.map(n => ({ text: n.text, x: X(n.fx), z: Z(n.fy), size: n.size ?? 1, rot: n.rot ?? 0 })),
    plan: { dataUrl, x0: -W / 2, x1: W / 2, z0: -H / 2, z1: H / 2 },
  };
}
