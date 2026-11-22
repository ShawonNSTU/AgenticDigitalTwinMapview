// The 4th floor's rooms and doors as the printed sheet draws them, applied to the traced preset (the public one in
// lib/presets or the private bundle's, so both agree). Surveyed against the sheet, door by door: every room is
// entered where the sheet has its door, with its leaf on the side the sheet swings it, and spaces the sheet leaves
// open (the cafeteria's hand-washing area, the passages round the lift blocks) are open in 3D too.
//
// Plan fractions: fx along the sheet's width, fy down it. A door's fw is a fraction of the width; rot is its wall's
// direction (0/π on a horizontal wall, ±π/2 on a vertical one) and its leaf opens towards (sin rot, cos rot).
// An "opening" is a doorway without a leaf (open plan): the two rooms meet with no wall between them there.
//
// What the trace had wrong (and the sheet shows):
// - Gym: entered from a small lobby off the cafeteria (east wall, top end), not from the small cafeteria. The small
//   cafeteria opens onto the same lobby (south wall, east end). Between the dressing rooms is a closed duct.
// - Ablution: one door in its north wall; the strip north of it belongs to the cafeteria. The hand-washing area is
//   open to the cafeteria and has a double door into Zone D. The 1800 mm corridor ends at the hand-washing area's
//   wall (no way through at its north end).
// - Zone D: passages run round the two lift blocks (north of the upper row, west of both, east of the lower row);
//   the north stair and the A/C room open onto the north passage, the core stair onto the passage by the toilets,
//   the utility room onto the west passage.
// - Experience Zone and Medical Room share a lobby off the south corridor; neither opens onto the 1800 corridor.
// - Hub room: a door in its north wall from a recess of the south corridor; the service passage to the female
//   toilet, store room 2 and the AC outdoor area is open off the same recess.
// - Male pray room: its north-west corner steps in round the south-west stair's door.
// Idempotent: applying it again changes nothing.

type Pt = [number, number];
export type PresetRoom = { name: string; pts: Pt[]; label?: string; labelAt?: Pt; zone?: string };
export type PresetItem = { kind: string; fx: number; fy: number; fw: number; fd: number; rot: number; opening?: boolean; [k: string]: unknown };

const PI = Math.PI, H = PI / 2;

/** Rooms by name: new outline (rooms not listed keep the traced one). null removes the room. */
const ROOMS: Record<string, { pts: Pt[] | null; zone?: string; add?: boolean }> = {
  'Gym Room': { pts: [[0.11295, 0.22286], [0.23679, 0.22286], [0.23679, 0.43071], [0.26684, 0.43071], [0.26684, 0.55], [0.11295, 0.55]] },
  'Cafeteria (208 seats)': { pts: [[0.26684, 0.06071], [0.75233, 0.06071], [0.75233, 0.092], [0.62435, 0.092], [0.62435, 0.32143], [0.63575, 0.32143], [0.63575, 0.55], [0.26684, 0.55], [0.26684, 0.26214], [0.23679, 0.26214], [0.23679, 0.22286], [0.26684, 0.22286]] },
  'Ablution Area': { pts: [[0.62435, 0.092], [0.75233, 0.092], [0.75233, 0.20714], [0.62435, 0.20714]] },
  'Hand Washing Area': { pts: [[0.62435, 0.20714], [0.75233, 0.20714], [0.75233, 0.275], [0.67047, 0.275], [0.67047, 0.32143], [0.62435, 0.32143]] },
  'A/C Room': { pts: [[0.77461, 0.23571], [0.80466, 0.23571], [0.80466, 0.282], [0.77461, 0.282]] },
  'Zone D North Passage': { add: true, zone: 'D', pts: [[0.67047, 0.275], [0.75233, 0.275], [0.75233, 0.23571], [0.77461, 0.23571], [0.77461, 0.282], [0.80466, 0.282], [0.80466, 0.3312], [0.6979, 0.3312], [0.6979, 0.3788], [0.67047, 0.3788]] },
  'Lift Lobby': { add: true, zone: 'D', pts: [[0.67047, 0.3788], [0.85492, 0.3788], [0.85492, 0.39643], [0.89741, 0.39643], [0.89741, 0.5298], [0.67047, 0.5298]] },
  'Zone D West Passage': { add: true, zone: 'D', pts: [[0.67047, 0.5298], [0.6933, 0.5298], [0.6933, 0.59286], [0.71244, 0.59286], [0.71244, 0.67857], [0.67047, 0.67857]] },
  'Zone D Workspace': { pts: [[0.8487, 0.5298], [0.89741, 0.5298], [0.89741, 0.63571], [0.82383, 0.63571], [0.82383, 0.59286], [0.8487, 0.59286]] },
  'Utility Room': { pts: [[0.67047, 0.67857], [0.79275, 0.67857], [0.79275, 0.73214], [0.67047, 0.73214]] },
  'Corridor': { pts: [[0.63575, 0.32143], [0.67047, 0.32143], [0.67047, 0.73214], [0.79275, 0.73214], [0.79275, 0.74643], [0.8342, 0.74643], [0.8342, 0.95807], [0.81451, 0.95514], [0.81451, 0.8268], [0.76166, 0.8268], [0.76166, 0.79286], [0.2868, 0.79286], [0.2868, 0.8128], [0.26684, 0.8128], [0.26684, 0.76071], [0.63575, 0.76071]] },
  'Service Passage': { pts: null },
  'Hub Room': { pts: [[0.76166, 0.8268], [0.81451, 0.8268], [0.81451, 0.95514], [0.76166, 0.94721]] },
  'Male Pray Room': { pts: [[0.26684, 0.8128], [0.2868, 0.8128], [0.2868, 0.79286], [0.62176, 0.79286], [0.62176, 0.92621], [0.26684, 0.87286]] },
  'Medical Room': { pts: [[0.53627, 0.64643], [0.61625, 0.64643], [0.61625, 0.76071], [0.53627, 0.76071]] },
  'Zone B Lobby': { add: true, zone: 'B', pts: [[0.61625, 0.64643], [0.63575, 0.64643], [0.63575, 0.76071], [0.61625, 0.76071]] },
};

const door = (fx: number, fy: number, fw: number, rot: number, opening = false): PresetItem => ({ kind: 'door', fx, fy, fw, fd: 0.00311, rot, ...(opening ? { opening: true } : {}) });

/** Every door and doorway on the floor (the sheet's; nothing else). */
export const DOORS_4F: PresetItem[] = [
  // Zone A
  door(0.29326, 0.17, 0.01658, PI),            // gate in the cafeteria's railing, west
  door(0.5399, 0.17, 0.01658, PI),             // gate in the railing, east
  door(0.25, 0.22286, 0.0167, PI),             // small cafeteria → gym lobby (its south wall, east end)
  door(0.23679, 0.2385, 0.0181, -H),           // gym ← gym lobby (east wall, top end)
  door(0.23679, 0.29143, 0.01451, -H),         // dressing room 1 → gym
  door(0.23679, 0.4, 0.01451, -H),             // dressing room 2 → gym
  door(0.6735, 0.092, 0.0185, 0),              // ablution (north wall)
  door(0.62435, 0.26429, 0.0829, H, true),     // cafeteria — hand-washing area, open
  door(0.67047, 0.2982, 0.0312, -H),           // hand-washing area — Zone D, double door
  door(0.63575, 0.45429, 0.03109, -H),         // cafeteria — 1800 corridor, glass double door
  // Zone D
  door(0.67047, 0.45429, 0.03109, H),          // 1800 corridor — lift lobby, double door (held open)
  door(0.76477, 0.23571, 0.01762, PI),         // north stair → north passage
  door(0.784, 0.282, 0.0166, 0),               // A/C room → north passage
  door(0.68419, 0.3788, 0.0274, 0, true),      // north passage — lift lobby, open
  door(0.68189, 0.5298, 0.0228, 0, true),      // lift lobby — west passage, open
  door(0.87306, 0.5298, 0.0487, 0, true),      // lift lobby — east (toilets) passage, open
  door(0.82383, 0.605, 0.017, -H),             // core stair ← passage by the toilets (stair's east wall)
  door(0.682, 0.67857, 0.0166, 0),             // utility room ← west passage
  door(0.8245, 0.74643, 0.0166, PI),           // male toilet ← south corridor
  door(0.8342, 0.77714, 0.01658, H),           // female toilet ← service passage
  door(0.8342, 0.848, 0.01658, H),             // store room 2 ← service passage
  door(0.8342, 0.918, 0.01554, H),             // AC outdoor ← service passage
  // Zone C
  door(0.8, 0.8268, 0.0166, PI),               // hub room (north wall) → corridor recess
  door(0.7499, 0.79286, 0.01762, 0),           // store room (east end of its corridor wall)
  door(0.64249, 0.79286, 0.01865, 0),          // female pray room (west end)
  door(0.60104, 0.79286, 0.01865, 0),          // male pray room, east door
  door(0.43523, 0.79286, 0.02073, 0),          // male pray room, west door
  door(0.26684, 0.78571, 0.01762, -H),         // south-west stair ← corridor
  // Zone B
  door(0.3228, 0.76071, 0.03109, PI),          // training room 403, double door
  door(0.35389, 0.76071, 0.01762, PI),         // training room 402, west
  door(0.48187, 0.76071, 0.01658, PI),         // training room 402, east
  door(0.49948, 0.76071, 0.01658, PI),         // maternity room
  // Experience Zone and Medical Room: their lobby off the south corridor. The zone's glass door is hinged on the
  // east; its open leaf stands in the zone along the east wall (into the lobby it would close off the Medical
  // Room's door). The Medical Room's door sits low enough to stay clear of the zone's wall when the zone is
  // enlarged for walking (stzone.ts growZone).
  door(0.626, 0.64643, 0.0166, PI),            // Experience Zone (south wall, east end)
  door(0.626, 0.76071, 0.0166, PI),            // Zone B lobby ← south corridor
  door(0.61625, 0.68643, 0.0166, -H),          // Medical Room ← Zone B lobby
];

/** Apply the sheet to the traced preset (in place). Only for the 4th floor: it needs the floor's own rooms. */
export function sheet4F(rooms: PresetRoom[], furniture: PresetItem[]) {
  const named = (n: string) => rooms.find(r => r.name === n);
  if (!['Gym Room', 'Cafeteria (208 seats)', 'Corridor', 'Zone D Workspace', 'Medical Room'].every(named)) return { rooms, furniture, applied: false };
  for (const [name, spec] of Object.entries(ROOMS)) {
    const r = named(name);
    if (spec.pts === null) { if (r) rooms.splice(rooms.indexOf(r), 1); continue; }
    if (r) {
      r.pts = spec.pts.map(p => [...p] as Pt);
      // a label left outside the new outline moves to its middle
      if (r.labelAt && !inside(spec.pts, r.labelAt)) r.labelAt = centre(spec.pts);
    } else if (spec.add) rooms.push({ name, zone: spec.zone, pts: spec.pts.map(p => [...p] as Pt), labelAt: centre(spec.pts) });
  }
  // the doors: the sheet's, in place of the traced ones
  for (let i = furniture.length - 1; i >= 0; i--) if (furniture[i].kind === 'door') furniture.splice(i, 1);
  furniture.push(...DOORS_4F.map(d => ({ ...d })));
  // keep the way in from the Medical Room's door clear: furniture along its top wall stops short of the east wall
  const med = named('Medical Room')!.pts, mx0 = Math.min(...med.map(p => p[0])), mx1 = Math.max(...med.map(p => p[0])), my0 = Math.min(...med.map(p => p[1]));
  const clear = mx1 - 0.015;   // about 80 cm
  for (const f of furniture) {
    if (f.kind === 'door' || f.kind === 'column' || f.fx < mx0 || f.fx > mx1 + 0.02 || f.fy < my0 || f.fy > my0 + 0.03) continue;
    const across = Math.abs(Math.sin(f.rot)) > 0.7;
    const half = (across ? f.fd : f.fw) / 2;
    if (f.fx + half <= clear) continue;
    const left = f.fx - half, w = Math.max(0.01, clear - left);
    if (across) f.fd = +w.toFixed(5); else f.fw = +w.toFixed(5);
    f.fx = +(left + w / 2).toFixed(5);
  }
  // nothing in the closed duct between the dressing rooms (it was traced as part of the gym)
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (f.kind !== 'column' && !f.duct && f.fx > 0.2368 && f.fx < 0.2668 && f.fy > 0.3022 && f.fy < 0.3906) furniture.splice(i, 1);
  }
  // the duct itself: a closed box, not a hole in the floor
  if (!furniture.some(f => f.duct)) furniture.push({ kind: 'cabinet', fx: 0.25182, fy: 0.34643, fw: 0.0286, fd: 0.0625, rot: 0, duct: true });
  // the structural columns, as the sheet draws them (solid squares on a 7.8 m grid)
  for (let i = furniture.length - 1; i >= 0; i--) if (furniture[i].kind === 'column') furniture.splice(i, 1);
  for (const [fx, fy, wm, dm] of COLUMNS_4F) furniture.push({ kind: 'column', fx, fy, fw: wm / SHEET_W_M, fd: dm / SHEET_W_M, rot: 0 });
  return { rooms, furniture, applied: true };
}

/** The sheet's width in metres (the preset's widthM): sizes below are in metres. */
const SHEET_W_M = 54.04;
/** Structural columns traced from the 4F sheet: [centre x, centre y (fractions of the sheet), width, depth (m)].
 *  Found as the solid black squares on a photo of the printed sheet, mapped onto this floor by fitting its walls
 *  (a perspective fit, about 0.1 m off), then put on the 7.8 m structural grid they stand on. */
const COLUMNS_4F: [number, number, number, number][] = [
  [0.1248, 0.1528, 1.4, 1.3], [0.2720, 0.1528, 1.2, 1.8], [0.4161, 0.1528, 1.2, 1.8], [0.5593, 0.1528, 1.2, 1.8], [0.7045, 0.1528, 1.0, 1.6],
  [0.1248, 0.3557, 1.4, 1.2], [0.2720, 0.3557, 1.2, 1.2], [0.4161, 0.3557, 1.2, 1.2], [0.5593, 0.3557, 1.2, 1.2],
  [0.1248, 0.5520, 1.4, 1.2], [0.2720, 0.5520, 1.2, 1.2], [0.4161, 0.5520, 1.2, 1.0], [0.5593, 0.5520, 1.2, 1.0],
  [0.1248, 0.7455, 1.4, 1.4], [0.2720, 0.7455, 1.2, 1.3], [0.4161, 0.7455, 1.2, 1.2], [0.5593, 0.7455, 1.2, 1.3], [0.7045, 0.7455, 1.2, 1.1], [0.8490, 0.7455, 1.2, 1.1],
  [0.4161, 0.8912, 1.0, 1.0], [0.5593, 0.8912, 1.0, 1.0], [0.7045, 0.8912, 1.0, 1.0], [0.8490, 0.8912, 1.0, 1.0],
];

function centre(pts: Pt[]): Pt {
  // the middle of the largest axis-aligned piece is good enough for a label: the bounding box centre, nudged inside
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const c: Pt = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  if (inside(pts, c)) return c;
  let best = pts[0], bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const t of [0.004, 0.008, 0.012]) for (const [dx, dy] of [[t, 0], [-t, 0], [0, t], [0, -t]]) {
      const q: Pt = [m[0] + dx, m[1] + dy];
      const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
      if (inside(pts, q) && d < bd) { bd = d; best = q; }
    }
  }
  return best;
}
function inside(pts: Pt[], [x, y]: Pt) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
