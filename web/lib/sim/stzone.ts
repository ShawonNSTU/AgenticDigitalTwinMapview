// The SmartThings Experience Zone on the 4th floor is a real, already fitted room: wood-panelled walls, a
// drop ceiling with light panels and AC diffusers, spot bulbs on the ceiling, four floor lamps, a grey tufted
// sofa facing a TV on a low unit, a coffee table, a roller projector screen, a white bookcase beside the
// panelled column, an L-desk with a monitor and two office chairs under a wall TV, a Bespoke air purifier and
// a glass door. Its SmartThings devices are installed, so a guest pass can be made for it straight away;
// every other room needs Hotel setup first (see guestReady).
//
// Positions are worked out from the room's outline and its door, so the zone stays furnished if the outline is
// traced a little differently.
import { ROOMS, DEV } from './engine';

type V = [number, number];
type Item = { kind: string; x: number; z: number; w: number; d: number; rot: number; glass?: boolean; room?: string };

export const ZONE_FINISH = 'st-zone';
const isZone = (r: any) => /smartthings|smart things/i.test(`${r.name} ${r.label ?? ''}`);
export const zoneRoom = () => ROOMS.find(isZone) as any | undefined;

/** Rooms with SmartThings devices already installed (no Hotel setup needed). */
export function fittedRooms(): string[] { return ROOMS.filter((r: any) => r.finish === ZONE_FINISH).map((r: any) => r.key); }

/** A guest pass needs a room with its devices in place: the fitted zone, or a room after Hotel setup (it has a door lock). */
export function guestReady(key: string) {
  const r = ROOMS.find((x: any) => x.key === key) as any;
  if (!r) return false;
  return r.finish === ZONE_FINISH || DEV.some((d: any) => d.room === key && d.type === 'lock');
}

const polyOf = (r: any): V[] => r.poly?.length >= 3 ? r.poly : [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]];

/**
 * Furnish the zone and install its devices. Room frame: the wall with the door is "door wall"; the TV unit stands
 * on the wall next to the door's near corner, the projector screen on the wall facing the door, the bookcase
 * and the L-desk on the wall facing the TV. Returns false when the floor has no such room.
 */
type Api = {
  rt: { furniture: any[] };
  addDevice: (p: { type: string; x: number; z: number; rotationY?: number; room?: string; name?: string }) => unknown;
  removeDevice: (id: string) => unknown;
};

// runtime.ts passes its state and device functions in (this module must not import runtime: runtime calls it while
// it is still loading)
export function fitSmartThingsZone({ rt, addDevice, removeDevice }: Api) {
  const r = zoneRoom();
  if (!r) return false;
  r.finish = ZONE_FINISH;
  const P = polyOf(r);
  const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const inside = (x: number, z: number) => x > x0 && x < x1 && z > z0 && z < z1;
  const door = rt.furniture.find(f => f.kind === 'door' && Math.abs(f.x - x1) < 0.3 && f.z > z0 && f.z < z1)
    ?? rt.furniture.find(f => f.kind === 'door' && (Math.abs(f.x - x0) < 0.3 || Math.abs(f.x - x1) < 0.3 || Math.abs(f.z - z0) < 0.3 || Math.abs(f.z - z1) < 0.3) && f.x > x0 - 0.3 && f.x < x1 + 0.3 && f.z > z0 - 0.3 && f.z < z1 + 0.3);

  // Local frame: u runs along the door wall from the door's far end to its near corner, n points into the room.
  // Default (the traced plan): door on the east wall near the south corner.
  let o: V = [x1, z0], u: V = [0, 1], n: V = [-1, 0], L = z1 - z0, D = x1 - x0;
  if (door) {
    const ws: { o: V; u: V; n: V; L: number; D: number; t: number }[] = [
      { o: [x1, z0], u: [0, 1], n: [-1, 0], L: z1 - z0, D: x1 - x0, t: door.z - z0 },   // east wall, going south
      { o: [x0, z1], u: [0, -1], n: [1, 0], L: z1 - z0, D: x1 - x0, t: z1 - door.z },   // west wall, going north
      { o: [x1, z1], u: [-1, 0], n: [0, -1], L: x1 - x0, D: z1 - z0, t: x1 - door.x },  // south wall, going west
      { o: [x0, z0], u: [1, 0], n: [0, 1], L: x1 - x0, D: z1 - z0, t: door.x - x0 },    // north wall, going east
    ];
    const dist = (w: typeof ws[0]) => Math.abs((door.x - w.o[0]) * w.n[0] + (door.z - w.o[1]) * w.n[1]);
    let w = ws.sort((a, b) => dist(a) - dist(b))[0];
    // keep the door near the end of u (the photos: door beside the TV corner)
    if (w.t < w.L / 2) {
      const end: V = [w.o[0] + w.u[0] * w.L, w.o[1] + w.u[1] * w.L];
      w = { ...w, o: end, u: [-w.u[0], -w.u[1]], t: w.L - w.t };
      // n stays: same wall, other direction
    }
    o = w.o; u = w.u; n = w.n; L = w.L; D = w.D;
  }
  // a point s metres along the door wall and q metres into the room
  const at = (s: number, q: number): [number, number] => [+(o[0] + u[0] * s + n[0] * q).toFixed(3), +(o[1] + u[1] * s + n[1] * q).toFixed(3)];
  // rot that faces direction (dx, dz): rot 0 faces +z, facing = (sin rot, cos rot)
  const face = (d: V) => +Math.atan2(d[0], d[1]).toFixed(4);
  const IN = face(n), OUT = face([-n[0], -n[1]]), ALONG = face(u), BACK = face([-u[0], -u[1]]);
  const g = 0.07; // inner face of the wall

  // 1. furniture: replace the traced interior (doors and the panelled column stay)
  rt.furniture = rt.furniture.filter(f => f.kind === 'door' || f.kind === 'column' || !inside(f.x, f.z));
  if (door) (door as Item).glass = true;
  const items: Item[] = [];
  const put = (kind: string, s: number, q: number, w: number, d: number, rot: number) => { const [x, z] = at(s, q); items.push({ kind, x, z, w, d, rot, room: r.key }); };
  // TV wall (the end wall beyond the door, s = L): low TV unit, coffee table and the sofa facing it, set off
  // the door side so the door can swing
  const mid = Math.min(D - 1.25, D / 2 + 0.3);
  put('tv_unit', L - g - 0.23, mid, 1.6, 0.45, BACK);
  put('coffee_table', L - 1.16, mid, 0.9, 0.6, BACK);
  put('tufted_sofa', L - 2.18, mid, 1.9, 0.85, ALONG);
  // projector wall (facing the door, q = D): floor lamps either side of the screen
  put('floor_lamp', L * 0.28, D - g - 0.25, 0.42, 0.42, 0);
  put('floor_lamp', L * 0.78, D - g - 0.25, 0.42, 0.42, 0);
  // start wall (s = 0): white bookcase clear of the panelled column, a framed print over the desk return
  put('bookcase_white', g + 0.21, Math.min(D - 1.65, 2.9), 1.0, 0.42, ALONG);
  put('poster', g + 0.02, 1.2, 0.7, 0.03, ALONG);
  // L-desk in the corner of the door wall and the start wall, under the wall TV, with a monitor and two chairs
  put('desk', g + 0.65, g + 0.31, 1.3, 0.62, OUT);
  put('desk', g + 0.29, g + 0.62 + 0.45, 0.9, 0.58, BACK);
  put('desk_lamp', g + 0.3, g + 0.3, 0.25, 0.25, IN);
  put('task_chair', g + 1.22, g + 0.95, 0.6, 0.6, OUT);
  put('task_chair', g + 0.82, 1.33, 0.6, 0.6, BACK);
  // door wall between the desk and the door, and beside the TV unit: two more lamps
  put('floor_lamp', 2.4, g + 0.25, 0.42, 0.42, 0);
  put('floor_lamp', L - g - 0.25, mid - 1.15, 0.42, 0.42, 0);
  rt.furniture = [...rt.furniture, ...items];

  // 2. SmartThings devices: named exactly as in the zone's SmartThings app (room 401), so real devices link by
  // name on /integrations. Where each one is comes from the room's device list:
  //   Light 1 back of the main TV · Light 2 top of the TV · Light 3 left, above the shelf · Light 4 between the
  //   curtain and the shelf · Light 5 door entrance · Desk lamp · TV lamp = the main ceiling lights ·
  //   aqara roller shade control = the white roller curtain · blinds switch powers the curtain motor ·
  //   Left window / Right window = lights behind the curtain · side lamp (dining room) = the big standing lamp
  //   between the shelf and the curtain
  for (const d of DEV.filter((d: any) => d.room === r.key)) removeDevice(d.id);
  const ids: Record<string, string> = {};
  const dev = (type: string, s: number, q: number, rot: number, name: string) => { const [x, z] = at(s, q); const res: any = addDevice({ type, x, z, rotationY: rot, room: r.key, name }); if (res?.device) ids[name] = res.device.id; };
  const shelfQ = Math.min(D - 1.65, 2.9);
  const blindS = L / 2 + 0.25;
  dev('light', L - 0.3, mid, 0, 'Light 1');
  dev('light', L - 0.85, mid + 0.45, 0, 'Light 2');
  dev('light', g + 0.45, shelfQ, 0, 'Light 3');
  dev('light', g + 0.75, D - 0.55, 0, 'Light 4');
  const dt = door ? Math.abs((door.x - o[0]) * u[0] + (door.z - o[1]) * u[1]) : L - 0.6;
  dev('light', dt, 0.55, 0, 'Light 5');
  dev('light', g + 0.3, g + 0.3, 0, 'Desk lamp');
  dev('light', L * 0.5, D * 0.42, 0, 'TV lamp');
  dev('blinds', blindS, D - g - 0.055, OUT, 'aqara roller shade control');
  dev('plug', blindS + 1.05, D - g - 0.02, OUT, 'blinds switch');
  dev('light', blindS - 0.42, D - g - 0.03, IN, 'Left window');
  dev('light', blindS + 0.42, D - g - 0.03, IN, 'Right window');
  dev('light', L * 0.28, D - g - 0.25, 0, 'side lamp (dining room)');
  // the rest of the room's Samsung kit
  dev('tv', L - g - 0.23, mid, BACK, 'TV 65"');
  dev('tv', g + 0.72, g + 0.04, IN, 'Wall TV');
  dev('ac', L * 0.62, D * 0.5, 0, 'Ceiling AC');
  dev('purifier', g + 1.72, g + 0.26, IN, 'Air purifier');
  const side = dt - 0.75 > 0.3 ? dt - 0.75 : dt + 0.75;
  dev('lock', side, 0.06, IN, 'Door lock');
  dev('temphum', side - 0.35, 0.04, IN, 'Temp & humidity');
  dev('camera', 0.75, D - 0.12, face([u[0] - n[0], u[1] - n[1]]), 'Indoor camera 1');
  dev('camera', L - 0.12, 0.2, face([n[0] - u[0], n[1] - u[1]]), 'Indoor camera 2');
  // the curtain motor only moves while its switch is on
  if (ids['aqara roller shade control'] && ids['blinds switch']) REQUIRES[ids['aqara roller shade control']] = ids['blinds switch'];
  return true;
}

/** Devices that only work while another one is on (the curtain motor and its switch): id -> id of the switch. */
export const REQUIRES: Record<string, string> = ((globalThis as any).__twinRequires ??= {});

/** Device types a guest neither sees nor controls (privacy). */
export const GUEST_HIDDEN = ['camera'];
