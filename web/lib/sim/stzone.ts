// The SmartThings Experience Zone on the 4th floor is a real, already fitted room: wood-panelled walls, a
// drop ceiling with light panels and AC diffusers, spot bulbs on a lowered band, three floor lamps, a grey tufted
// sofa facing a TV on a low unit, a coffee table, a back-lit window under a roller shade, a white bookcase beside the
// panelled column, an L-desk with a monitor and two office chairs under a wall TV, a Bespoke air purifier and
// a glass door. Its SmartThings devices are installed, so a guest pass can be made for it straight away;
// every other room needs Hotel setup first (see guestReady).
//
// Positions are worked out from the room's outline and its door, so the zone stays furnished if the outline is
// traced a little differently.
import { ROOMS, DEV } from './engine';

type V = [number, number];
type Item = { kind: string; x: number; z: number; w: number; d: number; rot: number; glass?: boolean; panel?: boolean; room?: string };

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
  addDevice: (p: { type: string; x: number; z: number; rotationY?: number; room?: string; name?: string; fixture?: string }) => unknown;
  removeDevice: (id: string) => unknown;
};

// runtime.ts passes its state and device functions in (this module must not import runtime: runtime calls it while
// it is still loading)
export function fitSmartThingsZone({ rt, addDevice, removeDevice }: Api) {
  const r = zoneRoom();
  if (!r) return false;
  r.finish = ZONE_FINISH;
  fitLiftLobby(rt);
  setArrival();
  growZone(r, rt.furniture);
  const P = polyOf(r);
  const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  // the structural columns stand everywhere else on the floor; the zone's own interior follows the reference photo
  rt.furniture = rt.furniture.filter(f => !(f.kind === 'column' && f.x > x0 - 0.2 && f.x < x1 + 0.2 && f.z > z0 - 0.2 && f.z < z1 + 0.2));
  const inside = (x: number, z: number) => x > x0 && x < x1 && z > z0 && z < z1;
  const door = rt.furniture.find(f => f.kind === 'door' && Math.abs(f.x - x1) < 0.3 && f.z > z0 && f.z < z1)
    ?? rt.furniture.find(f => f.kind === 'door' && (Math.abs(f.x - x0) < 0.3 || Math.abs(f.x - x1) < 0.3 || Math.abs(f.z - z0) < 0.3 || Math.abs(f.z - z1) < 0.3) && f.x > x0 - 0.3 && f.x < x1 + 0.3 && f.z > z0 - 0.3 && f.z < z1 + 0.3);

  // The glass door. In the real room (entry photo) it opens at the end of its wall next to the wall with the
  // main TV, and the open glass leaf rests against that wall: walking in, that wall is on your RIGHT and the
  // window wall is straight ahead. The traced plan puts the door at the other end of the same corridor wall,
  // which mirrors the whole room, so the door is moved to the right-hand end of its wall (same wall, same
  // corridor; idempotent).
  let o: V = [x1, z1], u: V = [0, -1], n: V = [-1, 0], L = z1 - z0, D = x1 - x0;
  if (door) {
    const walls: { a: V; b: V; n: V }[] = [
      { a: [x1, z0], b: [x1, z1], n: [-1, 0] }, { a: [x0, z0], b: [x0, z1], n: [1, 0] },
      { a: [x0, z1], b: [x1, z1], n: [0, -1] }, { a: [x0, z0], b: [x1, z0], n: [0, 1] },
    ];
    const off = (w: typeof walls[0]) => Math.abs((door.x - w.a[0]) * w.n[0] + (door.z - w.a[1]) * w.n[1]);
    const w = walls.sort((p, q) => off(p) - off(q))[0];
    n = w.n;
    // right of someone walking in along n (x east, z south, y up): (-n.z, n.x)
    const right: V = [-n[1], n[0]];
    const side = (c: V) => (c[0] - door.x) * right[0] + (c[1] - door.z) * right[1];
    const [c0, c1] = side(w.a) > side(w.b) ? [w.a, w.b] : [w.b, w.a];
    L = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    o = c0; u = [(c1[0] - c0[0]) / L, (c1[1] - c0[1]) / L];
    D = Math.abs((w.n[0] ? x1 - x0 : z1 - z0));
    const dwid = Number(door.w) || 0.95;
    const at0 = 0.08 + dwid / 2;   // the leaf's hinge side is right at the corner, as in the photo
    door.x = +(o[0] + u[0] * at0).toFixed(3); door.z = +(o[1] + u[1] * at0).toFixed(3);
  }
  // a point s metres along the door wall (from the door's corner) and q metres into the room
  const at = (s: number, q: number): [number, number] => [+(o[0] + u[0] * s + n[0] * q).toFixed(3), +(o[1] + u[1] * s + n[1] * q).toFixed(3)];
  // rot that faces direction (dx, dz): rot 0 faces +z, facing = (sin rot, cos rot)
  const face = (d: V) => +Math.atan2(d[0], d[1]).toFixed(4);
  // IN faces into the room from the door wall, OUT towards the door wall; ALONG faces away from the TV wall (towards
  // the far side wall), BACK towards the TV wall
  const IN = face(n), OUT = face([-n[0], -n[1]]), ALONG = face(u), BACK = face([-u[0], -u[1]]);
  const g = 0.07; // inner face of the wall
  const dw = door ? Number(door.w) || 0.95 : 0.95;
  const dt = door ? Math.abs((door.x - o[0]) * u[0] + (door.z - o[1]) * u[1]) : 0.6; // door centre along its wall

  // Walls, as the photos show them (walking in through the glass door):
  //   door wall (q = 0)          from the door: floor lamp, Bespoke air purifier, desk under the wall TV into the
  //                              far corner (dome camera above it)
  //   TV wall (s = 0, right)     the main TV on its walnut unit, Light 1 on the wall behind it, Light 5 (by the
  //                              door) and Light 2 (above the TV) on the lowered band, a floor lamp in the far corner
  //   window wall (q = D)        straight ahead: the back-lit window (Left / Right Window Light) under the Aqara
  //                              roller shade, Light 4 above its left end, the side lamp, the white bookcase in
  //                              the left corner against the panelled column with Light 3 above it; cameras in
  //                              both corners; the Blinds Switch by the shade's right end
  //   left wall (s = L)          the desk return with the desk lamp and flowers, the framed print
  //   middle                     grey tufted sofa facing the TV, coffee table between
  // A lowered white band (bulkhead) runs along the TV wall and the window wall; the spot bulbs hang from it.

  // 1. furniture: replace the traced interior (doors and the panelled column stay)
  rt.furniture = rt.furniture.filter(f => f.kind === 'door' || f.kind === 'column' || !inside(f.x, f.z));
  if (door) (door as Item).glass = true;
  const items: Item[] = [];
  const put = (kind: string, s: number, q: number, w: number, d: number, rot: number) => { const [x, z] = at(s, q); items.push({ kind, x, z, w, d, rot, room: r.key }); };
  const band = 0.55;                                       // bulkhead depth from the wall
  const qTv = Math.min(D - 1.75, Math.max(dw + 1.55, D * 0.47)); // TV clear of the open door leaf
  const sSofa = Math.min(L - 1.05, 2.75), sTable = (0.53 + sSofa - 0.45) / 2 + 0.05;
  // TV wall
  put('tv_unit', g + 0.23, qTv, 1.6, 0.45, ALONG);
  put('floor_lamp', g + 0.28, D - g - 0.3, 0.42, 0.42, 0);            // far corner by the TV
  // middle: coffee table and the sofa facing the TV
  put('coffee_table', sTable, qTv, 0.9, 0.6, ALONG);
  put('tufted_sofa', sSofa, qTv + 0.1, 1.9, 0.85, BACK);
  // window wall: the window itself is the two window lights' panes (devices below)
  const sWin = Math.min(L - 1.95, Math.max(1.35, L * 0.47));
  put('bookcase_white', L - g - 0.47, D - g - 0.21, 0.9, 0.42, OUT);
  put('floor_lamp', L - g - 1.2, D - g - 0.28, 0.42, 0.42, 0);        // the side lamp's stand
  // door wall: floor lamp beside the door, (purifier), desk under the wall TV running into the corner
  const deskLen = Math.min(1.9, L - (dt + dw / 2) - 1.1);
  const sDesk = L - g - deskLen / 2;
  put('floor_lamp', dt + dw / 2 + 0.33, g + 0.27, 0.42, 0.42, 0);
  put('desk_one', sDesk, g + 0.31, deskLen, 0.62, IN);
  put('mesh_chair', sDesk - 0.3, g + 0.95, 0.6, 0.6, OUT);
  // left wall: desk return (desk lamp, flowers), print
  put('desk_plain', L - g - 0.29, g + 0.62 + 0.75, 1.5, 0.58, BACK);
  put('mesh_chair', L - g - 0.95, g + 0.62 + 0.8, 0.6, 0.6, ALONG);
  put('desk_lamp', L - g - 0.25, g + 0.62 + 0.18, 0.25, 0.25, BACK);
  put('desk_flowers', L - g - 0.3, g + 0.62 + 1.1, 0.45, 0.3, BACK);
  put('poster', L - g - 0.02, Math.min(D - 1.3, g + 0.62 + 1.5 + 0.75), 0.7, 0.03, BACK);
  rt.furniture = [...rt.furniture, ...items];

  // the drop ceiling, for the 3D view: bulkhead along the TV wall and the window wall, LED panels, AC diffusers
  const rect = (s0: number, q0: number, s1: number, q1: number) => {
    const [ax, az] = at(s0, q0), [bx, bz] = at(s1, q1);
    return { x: +((ax + bx) / 2).toFixed(3), z: +((az + bz) / 2).toFixed(3), w: +Math.abs(bx - ax).toFixed(3), d: +Math.abs(bz - az).toFixed(3) };
  };
  r.ceiling = {
    band: [rect(0, 0, band, D), rect(band, D - band, L, D)],
    drop: 0.28,
    panels: [rect(L * 0.42 - 0.3, D * 0.42 - 0.6, L * 0.42 + 0.3, D * 0.42 + 0.6), rect(L * 0.66 - 0.3, D * 0.7 - 0.6, L * 0.66 + 0.3, D * 0.7 + 0.6),
      rect(L * 0.3 - 0.3, D - band - 1.0, L * 0.3 + 0.3, D - band - 0.4), rect(L * 0.75 - 0.3, D - band - 1.0, L * 0.75 + 0.3, D - band - 0.4)],
    diffusers: [rect(1.0, 1.0, 1.6, 1.6), rect(L * 0.52 - 0.3, D * 0.62 - 0.3, L * 0.52 + 0.3, D * 0.62 + 0.3)],
    returns: [rect(L * 0.52 - 0.3, D - band - 1.0, L * 0.52 + 0.3, D - band - 0.4)],
  };

  // where to stand to take the room in on walking in (3D walk-through): inside the door, clear of the TV unit and
  // the floor lamp, looking across to the window wall as the entry photo does
  const [vx, vz] = at(1.05, 0.95), [lx, lz] = at(L * 0.58, D);
  r.view = { at: [vx, vz], look: [lx, 1.15, lz] };

  // 2. SmartThings devices: named exactly as the zone's real SmartThings devices (lib/integrations/zone-devices.ts),
  // which they are linked to by deviceId, placed where they are in the room, and with their fixture for the 3D view
  for (const d of DEV.filter((d: any) => d.room === r.key)) removeDevice(d.id);
  const ids: Record<string, string> = {};
  const dev = (type: string, s: number, q: number, rot: number, name: string, fixture?: string) => {
    const [x, z] = at(s, q);
    const res: any = addDevice({ type, x, z, rotationY: rot, room: r.key, name, ...(fixture ? { fixture } : {}) });
    if (res?.device) ids[name] = res.device.id;
  };
  const spot = band / 2;   // spot bulbs hang from the middle of the band
  dev('light', g + 0.05, qTv + 0.35, ALONG, 'Light 1', 'wall');            // on the wall behind the main TV
  // spots face away from the wall behind them (the 3D view washes that wall with their light)
  dev('light', spot, qTv + 0.95, ALONG, 'Light 2', 'spot');                // on the band above the TV
  dev('light', L - g - 0.47, D - spot, OUT, 'Light 3', 'spot');            // above the bookcase
  dev('light', sWin + 0.95, D - spot, OUT, 'Light 4', 'spot');             // between the curtain and the shelf
  dev('light', spot, dw + 0.45, ALONG, 'Light 5', 'spot');                 // by the door entrance
  dev('light', L - g - 0.25, g + 0.62 + 0.18, 0, 'Desk Lamp', 'desk');
  dev('light', L * 0.42, D * 0.42, 0, 'TV Lamp', 'panel');                 // the main ceiling lights (LED panels)
  dev('blinds', sWin, D - g - 0.085, OUT, 'Aqara Roller Shade Controller', 'roller');
  dev('light', sWin + 0.33, D - g - 0.035, OUT, 'Left Window Light', 'window');   // left pane, seen from the room
  dev('light', sWin - 0.33, D - g - 0.035, OUT, 'Right Window Light', 'window');
  dev('plug', sWin - 0.95, D - g - 0.02, OUT, 'Blinds Switch');
  dev('light', L - g - 1.2, D - g - 0.28, 0, 'side lamp', 'lamp');         // in the standing lamp by the bookcase
  // the rest of the room's Samsung kit (simulated)
  dev('tv', g + 0.23, qTv, ALONG, 'TV 65"');
  dev('tv', sDesk + 0.05, g + 0.04, IN, 'Wall TV');
  dev('ac', L * 0.52, D * 0.62, 0, 'Ceiling AC');
  dev('purifier', dt + dw / 2 + 0.85, g + 0.24, IN, 'Air purifier', 'bespoke');   // coral Bespoke cube
  dev('lock', dt + dw / 2 + 0.14, 0.06, IN, 'Door lock');
  dev('temphum', dt + dw / 2 + 0.55, 0.04, IN, 'Temp & humidity');
  dev('camera', L - 0.15, 0.15, face([n[0] - u[0], n[1] - u[1]]), 'Indoor camera 1');       // over the desk corner
  dev('camera', L - 0.15, D - 0.15, face([-n[0] - u[0], -n[1] - u[1]]), 'Indoor camera 2'); // above the bookcase
  dev('camera', 0.15, D - 0.15, face([u[0] - n[0], u[1] - n[1]]), 'Indoor camera 3');       // window / TV corner
  for (const k of Object.keys(ST_PROFILE)) delete ST_PROFILE[k];
  for (const [name, id] of Object.entries(ids)) if (PROFILES[name]) ST_PROFILE[id] = PROFILES[name];
  // the curtain motor only moves while its switch is on
  for (const k of Object.keys(REQUIRES)) delete REQUIRES[k];
  if (ids['Aqara Roller Shade Controller'] && ids['Blinds Switch']) REQUIRES[ids['Aqara Roller Shade Controller']] = ids['Blinds Switch'];
  return true;
}

/**
 * The traced plan draws the zone smaller than it is to walk round in 3D (about 4.5 x 3.8 m), so it is enlarged by
 * about a fifth each way, keeping its proportions: its far wall moves into the room beside it (up to that room's
 * own wall line) and its wall opposite the corridor side's far end moves into the room behind it. Neighbouring
 * outlines give up the same strip; the glass door keeps its place by the corner and the wood-clad pillar stays in
 * its corner.
 */
const GROW = 1.19;
function growZone(r: any, furniture: any[]) {
  if (r.grown) return;
  const P = polyOf(r);
  const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  if (P.length !== 4) return; // only a plain rectangle
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  // west: as far as the neighbour's own west notch allows (the maternity room's wall line), else a fifth
  let nx0 = x0 - (x1 - x0) * (GROW - 1);
  let snap = Infinity;
  for (const o of ROOMS as any[]) if (o !== r && o.poly) for (const [x, z] of o.poly) if (z > z1 - 0.05 && x < x0 - 0.3 && x > x0 - 1.4 && Math.abs(x - nx0) < Math.abs(snap - nx0)) snap = x;
  if (Number.isFinite(snap) && Math.abs(snap - nx0) < 0.35) nx0 = snap;
  const nz1 = z1 + (z1 - z0) * (GROW - 1) * 1.07;
  const dz = nz1 - z1, dx = nx0 - x0;
  const inZone = (x: number, z: number) => x > x0 && x < x1 && z > z0 && z < z1;
  for (const o of ROOMS as any[]) {
    if (o === r || !o.poly) continue;
    let moved = false;
    const ob = { x: [...o.x], z: [...o.z] }, opoly = o.poly.map((p: number[]) => [...p]);
    o.poly = o.poly.map(([x, z]: [number, number]) => {
      let nx = x, nz = z;
      if (near(x, x0) && z >= z0 - 0.05 && z <= z1 + 0.05) { nx = nx0; moved = true; }
      if (near(z, z1) && nx >= nx0 - 0.05 && nx <= x1 + 0.05) { nz = nz1; moved = true; }
      return [+nx.toFixed(3), +nz.toFixed(3)];
    }).filter((p: number[], i: number, a: number[][]) => {
      const q = a[(i + a.length - 1) % a.length];
      return !(near(p[0], q[0]) && near(p[1], q[1]));
    });
    // drop points in the middle of a straight edge
    o.poly = o.poly.filter((p: number[], i: number, a: number[][]) => {
      const pr = a[(i + a.length - 1) % a.length], nx = a[(i + 1) % a.length];
      return !((near(pr[0], p[0]) && near(p[0], nx[0])) || (near(pr[1], p[1]) && near(p[1], nx[1])));
    });
    if (moved) {
      const oxs = o.poly.map((p: number[]) => p[0]), ozs = o.poly.map((p: number[]) => p[1]);
      o.x = [Math.min(...oxs), Math.max(...oxs)]; o.z = [Math.min(...ozs), Math.max(...ozs)];
      // the room's own furniture moves in with its wall (squeezed along the side that moved), so nothing is left
      // in the strip it gave up or crowded against its new wall
      const inOld = (x: number, z: number) => {
        let c = false;
        for (let i = 0, j = opoly.length - 1; i < opoly.length; j = i++) {
          const [xi, zi] = opoly[i], [xj, zj] = opoly[j];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
        }
        return c;
      };
      const sx = (o.x[1] - o.x[0]) / (ob.x[1] - ob.x[0] || 1), sz = (o.z[1] - o.z[0]) / (ob.z[1] - ob.z[0] || 1);
      for (const f of furniture) {
        if (f.kind === 'door' || f.kind === 'column' || !inOld(f.x, f.z) || inZone(f.x, f.z)) continue;
        if (Math.abs(sx - 1) > 0.001) f.x = +(o.x[0] + (f.x - ob.x[0]) * sx).toFixed(3);
        if (Math.abs(sz - 1) > 0.001) f.z = +(o.z[0] + (f.z - ob.z[0]) * sz).toFixed(3);
      }
    }
  }
  r.poly = [[nx0, z0], [x1, z0], [x1, nz1], [nx0, nz1]].map(p => p.map(v => +v.toFixed(3)));
  r.x = [nx0, x1]; r.z = [z0, nz1];
  // the door by the corner it was beside, the pillar in the corner it was in
  for (const f of furniture) {
    if (f.kind === 'door' && near(f.x, x1) && f.z > z0 && f.z < z1) { if (z1 - f.z < (z1 - z0) / 2) f.z = +(f.z + dz).toFixed(3); }
    else if (f.kind === 'door' && near(f.z, z1) && f.x > x0 && f.x < x1) f.z = +nz1.toFixed(3);
    else if (f.kind === 'door' && near(f.x, x0) && f.z > z0 && f.z < z1) f.x = +nx0.toFixed(3);
    else if (f.kind === 'column' && Math.abs(f.x - x0) < 1.0 && Math.abs(f.z - z0) < 1.0) f.x = +(f.x + dx).toFixed(3);
  }
  r.grown = true;
}

/**
 * The 4th floor's lift lobby, in Zone D: six lift shafts in two rows of three (the drawing's large boxes, traced as
 * workstations) with the lobby between them (its four ceiling squares were traced as tables). L1-L3 (north row)
 * have steel doors, L4-L6 (south row) panelled ones (photos). The lobby's west side has a door that is always
 * open onto the passage, and straight across the passage the glass double doors of the main cafeteria (frosted
 * side panels, EXIT sign over them, water bottles stacked beside them). Guests arrive here.
 */
export const LOBBY_FINISH = 'lift-lobby';
function fitLiftLobby(rt: { furniture: any[] }) {
  const drawn = (ROOMS as any[]).find(r => r.key === 'lift-lobby');
  if (drawn?.finish === LOBBY_FINISH) return;
  if (drawn) { fitDrawnLobby(rt, drawn); return; }
  const zd = (ROOMS as any[]).find(r => /zone d/i.test(String(r.name)));
  if (!zd) return;
  const inRect = (f: any, x0: number, x1: number, z0: number, z1: number) => f.x > x0 && f.x < x1 && f.z > z0 && f.z < z1;
  const zx0 = zd.x[0];
  // the shafts: the six traced "workstations" in two rows across Zone D
  const shafts = rt.furniture.filter(f => f.kind === 'workstation' && inRect(f, zd.x[0], zd.x[1], zd.z[0], zd.z[1]));
  if (shafts.length !== 6) return;
  const zs = [...new Set(shafts.map(f => f.z))].sort((p, q) => p - q);
  if (zs.length !== 2) return;
  const north = shafts.filter(f => f.z === zs[0]).sort((p, q) => p.x - q.x), south = shafts.filter(f => f.z === zs[1]).sort((p, q) => p.x - q.x);
  const half = (f: any) => f.d / 2;
  const lz0 = +(zs[0] + half(north[0])).toFixed(3), lz1 = +(zs[1] - half(south[0])).toFixed(3);   // lobby between the rows
  const lx1 = Math.max(...north.map(f => f.x + f.w / 2), ...south.map(f => f.x + f.w / 2));
  const bx1 = +(zd.poly.map((p: number[]) => p[0]).filter((x: number) => x <= lx1 + 0.4).reduce((m: number, x: number) => Math.max(m, x), lx1)).toFixed(3); // Zone D's own step line
  // Zone D keeps what lies east of the lift block, and the strip below it beside the core stair
  const P: number[][] = zd.poly;
  const right = Math.max(...P.map(p => p[0])), bottom = Math.max(...P.map(p => p[1]));
  const eTop = Math.min(...P.filter(p => p[0] > bx1 + 0.01).map(p => p[1]));
  const lowLeft = Math.min(...P.filter(p => Math.abs(p[1] - bottom) < 0.01).map(p => p[0]));
  const bBot = Math.max(...P.filter(p => p[0] < bx1 - 0.01 && p[1] < bottom - 0.01).map(p => p[1]));   // the lift block's bottom
  const bz0 = zd.z[0], bz1 = bBot;
  // the lobby runs between the two rows of lifts and on to Zone D's east wall; Zone D keeps the area south-east of
  // the lower row (and the strip beside the core stair)
  const lobbyPoly: number[][] = eTop > lz0 + 0.01
    ? [[zx0, lz0], [bx1, lz0], [bx1, eTop], [right, eTop], [right, lz1], [zx0, lz1]]
    : [[zx0, lz0], [right, lz0], [right, lz1], [zx0, lz1]];
  const eastPoly: number[][] = lowLeft < bx1 - 0.01
    ? [[bx1, lz1], [right, lz1], [right, bottom], [lowLeft, bottom], [lowLeft, bBot], [bx1, bBot]]
    : [[bx1, lz1], [right, lz1], [right, bottom], [bx1, bottom]];
  zd.poly = eastPoly; zd.x = [Math.min(...eastPoly.map(p => p[0])), right]; zd.z = [lz1, bottom];
  zd.labelAt = [(bx1 + right) / 2, (lz1 + bottom) / 2];
  const cx = (zx0 + right) / 2, cz = (lz0 + lz1) / 2;
  (ROOMS as any[]).push({ key: 'lift-lobby', name: 'Lift Lobby', label: 'Lift Lobby', x: [zx0, right], z: [lz0, lz1],
    poly: lobbyPoly, color: '#9fb0e6', labelAt: [cx, cz], zone: zd.zone ?? 'D', finish: LOBBY_FINISH });
  // replace the traced shafts and ceiling squares; keep doors
  rt.furniture = rt.furniture.filter(f => f.kind === 'door' || !(inRect(f, zx0 - 0.01, bx1 + 0.01, bz0 - 0.01, bz1 + 0.01) || inRect(f, zx0, right, lz0, lz1)));
  furnishLobby(rt, north, south, zx0, lz0, lz1);
}

/**
 * The lobby is drawn as its own room (the sheet's survey, sheet4f.ts: passages round both lift blocks stay open):
 * only the lifts and the doors are fitted. The shafts are the traced "workstations" just north and south of it.
 */
function fitDrawnLobby(rt: { furniture: any[] }, lobby: any) {
  lobby.finish = LOBBY_FINISH;
  const [x0, x1] = lobby.x, [lz0, lz1] = lobby.z;
  const shafts = rt.furniture.filter(f => f.kind === 'workstation' && f.x > x0 && f.x < x1 && ((f.z < lz0 && f.z > lz0 - 4) || (f.z > lz1 && f.z < lz1 + 4)));
  const north = shafts.filter(f => f.z < lz0).sort((p, q) => p.x - q.x), south = shafts.filter(f => f.z > lz1).sort((p, q) => p.x - q.x);
  if (north.length !== 3 || south.length !== 3) return;
  const inRect = (f: any, a: number, b: number, c: number, d: number) => f.x > a && f.x < b && f.z > c && f.z < d;
  rt.furniture = rt.furniture.filter(f => f.kind === 'door' || !(shafts.includes(f) || inRect(f, x0, x1, lz0, lz1)));
  furnishLobby(rt, north, south, x0, lz0, lz1);
}

/** The six lifts (shaft and door on the lobby wall), the lobby's open west door and the cafeteria's glass doors. */
function furnishLobby(rt: { furniture: any[] }, north: any[], south: any[], zx0: number, lz0: number, lz1: number) {
  const items: Item[] = [];
  for (const row of [north, south]) for (const f of row) {
    const isNorth = row === north;
    // the shaft itself (solid), and its door on the lobby wall
    // the shaft stops behind the lobby wall, so its doors and call panels stand in the lobby (the traced boxes can
    // run a little past the wall line the sheet's survey gives the lobby)
    const far = isNorth ? f.z - f.d / 2 : f.z + f.d / 2;
    const near = isNorth ? Math.min(f.z + f.d / 2, lz0 - 0.06) : Math.max(f.z - f.d / 2, lz1 + 0.06);
    const sd = Math.abs(near - far);
    items.push({ kind: 'lift_shaft', x: f.x, z: +((near + far) / 2).toFixed(3), w: f.w, d: +sd.toFixed(3), rot: 0, room: 'lift-lobby' });
    items.push({ kind: 'lift_door', x: f.x, z: +(isNorth ? lz0 + 0.09 : lz1 - 0.09).toFixed(3), w: 1.1, d: 0.12, rot: isNorth ? 0 : Math.PI, ...(isNorth ? {} : { panel: true }), room: 'lift-lobby' });
  }
  // the lobby's west door stands open; the cafeteria's glass doors face it across the passage
  const lobbyDoor = rt.furniture.find(f => f.kind === 'door' && Math.abs(f.x - zx0) < 0.1 && f.z > lz0 && f.z < lz1);
  if (lobbyDoor) lobbyDoor.held_open = true;
  const cafeDoor = lobbyDoor && rt.furniture.find(f => f.kind === 'door' && f !== lobbyDoor && Math.abs(f.z - lobbyDoor.z) < 0.3 && f.x < zx0 && f.x > zx0 - 3);
  if (cafeDoor) {
    cafeDoor.glass = true;
    items.push({ kind: 'exit_sign', x: +(cafeDoor.x + 0.1).toFixed(3), z: cafeDoor.z, w: 0.5, d: 0.08, rot: Math.PI / 2, room: 'corridor' });
    items.push({ kind: 'water_bottles', x: +(cafeDoor.x + 0.4).toFixed(3), z: +(cafeDoor.z - cafeDoor.w / 2 - 0.75).toFixed(3), w: 0.9, d: 0.55, rot: Math.PI / 2, room: 'corridor' });
  }
  rt.furniture = [...rt.furniture, ...items];
}

/**
 * Where guests arrive on the floor. On the 4th floor that is the South-West Stair: the wide main staircase,
 * opening straight onto the main corridor in front of the training rooms, from where every guest room is reached
 * along the corridor. The Core Stair is closed in behind the Utility Room (no way through to the guest rooms), so
 * it is not offered as a starting point. Set when the floor is loaded; empty on other floors.
 */
export const ARRIVAL: { key: string; closed: string[] } = ((globalThis as any).__twinArrival ??= { key: '', closed: [] });
export function setArrival() {
  const find = (re: RegExp) => (ROOMS as any[]).find(r => re.test(String(r.name)))?.key ?? '';
  ARRIVAL.key = find(/lift lobby/i) || find(/south-?west stair/i);
  ARRIVAL.closed = [find(/core stair/i)].filter(Boolean);
}

/** Devices that only work while another one is on (the curtain motor and its switch): id -> id of the switch. */
export const REQUIRES: Record<string, string> = ((globalThis as any).__twinRequires ??= {});

/** How each of the zone's SmartThings app devices works, as the app shows it: a colour bulb (level, scenes,
 *  colours), a switch, or the roller shade; and the app's room it is listed under. id -> profile. */
export type StProfile = { kind: 'color' | 'switch' | 'shade'; group: string; where: string };
export const ST_PROFILE: Record<string, StProfile> = ((globalThis as any).__twinStProfile ??= {});
const PROFILES: Record<string, Omit<StProfile, 'where'> & { where: string }> = {
  'Aqara Roller Shade Controller': { kind: 'shade', group: 'Dining room', where: 'Roller shade over the window' },
  'Blinds Switch': { kind: 'switch', group: 'Living room', where: 'Powers the roller shade motor' },
  'Desk Lamp': { kind: 'color', group: 'Living room', where: 'On the desk' },
  'Left Window Light': { kind: 'switch', group: 'Living room', where: 'Back-lit window, left pane' },
  'Light 1': { kind: 'color', group: 'Living room', where: 'On the wall behind the main TV' },
  'Light 2': { kind: 'color', group: 'Living room', where: 'Spot above the TV' },
  'Light 3': { kind: 'color', group: 'Living room', where: 'Spot above the bookcase' },
  'Light 4': { kind: 'color', group: 'Living room', where: 'Spot between the shade and the bookcase' },
  'Right Window Light': { kind: 'switch', group: 'Living room', where: 'Back-lit window, right pane' },
  'TV Lamp': { kind: 'switch', group: 'Living room', where: 'Main ceiling lights (LED panels)' },
  'Light 5': { kind: 'color', group: 'Bedroom', where: 'Spot by the door' },
  'side lamp': { kind: 'switch', group: 'Dining room', where: 'Standing lamp by the bookcase' },
};
/** What each real zone device IS, in the words people use for it: the assistant reasons with these (a guest says
 *  "the window" or "the curtain", not "Left Window Light"). */
export const ST_MEANING: Record<string, string> = {
  'Left Window Light': 'The LEFT WINDOW of the room: a back-lit window pane behind the roller shade. On = the window glows and shows the outside view; off = dark glass. Also called: window, left window, window view.',
  'Right Window Light': 'The RIGHT WINDOW of the room: a back-lit window pane behind the roller shade. On = the window glows and shows the outside view; off = dark glass. Also called: window, right window, window view.',
  'Aqara Roller Shade Controller': 'The CURTAIN / roller shade in front of both windows. Shade level 100 % = fully open (rolled up, windows visible); 0 % = fully closed (down, windows hidden). Also called: curtain, blind, shade, blackout.',
  'Blinds Switch': 'Power switch for the roller shade motor. It is switched on automatically before the shade moves; rarely needs a request of its own.',
  'TV Lamp': "The room's MAIN CEILING LIGHTS (LED panels). Also called: ceiling light, main light, room light.",
  'Light 1': 'Colour light on the wall behind the main TV (TV backlight / ambient glow).',
  'Light 2': 'Colour spot light above the TV.',
  'Light 3': 'Colour spot light above the bookcase.',
  'Light 4': 'Colour spot light between the shade and the bookcase.',
  'Light 5': 'Colour spot light by the door (entrance light).',
  'Desk Lamp': 'Colour lamp on the desk (reading / work light).',
  'side lamp': 'Standing floor lamp by the bookcase.',
};
/** How the SmartThings Experience Zone works, for the assistant's reasoning. */
export const ZONE_GUIDE = [
  'To see the outside view: open the curtain fully (Aqara Roller Shade Controller to 100 %) AND turn on both window lights (Left Window Light, Right Window Light). The windows are back-lit panels, so they only show the view when on.',
  'For privacy or a dark room: close the curtain (0 %) and turn the window lights off.',
  'Main room light = TV Lamp (ceiling panels). Accent lights = Light 1-5. Reading = Desk Lamp. Cosy = side lamp plus dim warm accent lights.',
  'Movie: TV on, ceiling lights (TV Lamp) off, accent lights 10-25 % warm, curtain closed.',
];

/** Commands each kind offers (the rest of a light's commands are hidden, as the app does). */
export const ST_KIND_COMMANDS: Record<StProfile['kind'], string[]> = {
  color: ['power', 'setLevel', 'setColorTemperature', 'setColor'],
  switch: ['power'],
  shade: ['open', 'close', 'setPosition'],
};

/** Device types a guest neither sees nor controls (privacy). */
export const GUEST_HIDDEN = ['camera'];
