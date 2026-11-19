// Helpers for turning an uploaded floor plan (image coordinates 0..1) into a 3D layout (metres).
import types from '@/lib/sim/data/device_types.json';

export const DEVICE_TYPES = Object.entries(types as Record<string, { label: string }>).map(([key, t]) => ({ key, label: t.label }));

export const PREFIX: Record<string, string> = { ac: 'AC', odu: 'ODU', light: 'LT', tv: 'TV', speaker: 'SP', blinds: 'BL', fridge: 'FR', oven: 'OV', vacuum: 'VC', camera: 'CM', doorbell: 'DB', lock: 'DL', leak: 'LK', washer: 'WA', dryer: 'DR', temphum: 'TH', motion: 'MS', plug: 'PL', purifier: 'AP' };

/** Mount height in metres per type (same as the sample home). */
export const MOUNT: Record<string, number> = { ac: 2.15, odu: 0, light: 2.6, tv: 1.2, speaker: 0.55, blinds: 1.7, fridge: 0.9, oven: 0.45, vacuum: 0.06, camera: 2.2, doorbell: 1.3, lock: 1, washer: 0.45, dryer: 0.45, leak: 0.02, temphum: 1.5, motion: 2.2, plug: 0.35, purifier: 0.3 };

const COLORS = ['#8fb4f2', '#a8d8a0', '#c7b7ef', '#f2dc8f', '#8fd8d0', '#f2b8c6', '#c3e6a4', '#9fd0f0', '#94b8e8', '#a6e3c8'];

export type PlanRoom = { key: string; name: string; x0: number; y0: number; x1: number; y1: number; color: string }; // fractions
export type PlanDevice = { id: string; type: string; fx: number; fy: number };

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

export function roomAt(rooms: PlanRoom[], fx: number, fy: number) {
  return rooms.find(r => fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1) ?? null;
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
      out.push({ id: nextId(type, out), type, fx: r.x0 + (r.x1 - r.x0) * sx, fy: r.y0 + (r.y1 - r.y0) * sy });
    }
  }
  if (!out.some(d => d.type === 'odu') && out.some(d => d.type === 'ac')) {
    const minY = Math.min(...rooms.map(r => r.y0));
    out.push({ id: nextId('odu', out), type: 'odu', fx: outdoor?.x ?? 0.5, fy: outdoor?.y ?? minY - 0.05 });
  }
  return out;
}

/** Convert the editor state to the POST /api/building body. widthM is the real width of the image in metres. */
export function toBuilding(rooms: PlanRoom[], devices: PlanDevice[], widthM: number, aspect: number, dataUrl: string) {
  const W = widthM, H = widthM * aspect;
  const X = (f: number) => +((f - 0.5) * W).toFixed(3), Z = (f: number) => +((f - 0.5) * H).toFixed(3);
  return {
    rooms: rooms.map(r => ({ key: r.key, name: r.name, x: [X(r.x0), X(r.x1)], z: [Z(r.y0), Z(r.y1)], color: r.color })),
    devices: devices.map(d => {
      const r = roomAt(rooms, d.fx, d.fy);
      const x = X(d.fx), z = Z(d.fy);
      // Face the device towards the middle of its room (rotationY 0 faces +z).
      const rot = r ? Math.atan2(X((r.x0 + r.x1) / 2) - x, Z((r.y0 + r.y1) / 2) - z) : 0;
      const label = DEVICE_TYPES.find(t => t.key === d.type)?.label ?? d.type;
      return { id: d.id, type: d.type, room: r?.key ?? 'out', name: `${label} · ${r?.name ?? 'Outside'}`, position: [x, MOUNT[d.type] ?? 1, z], rotationY: +rot.toFixed(4) };
    }),
    plan: { dataUrl, x0: -W / 2, x1: W / 2, z0: -H / 2, z1: H / 2 },
  };
}
