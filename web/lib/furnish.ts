// Suggested interiors for rooms of an uploaded plan, from each room's name and size.
// Used when the plan itself gives no furniture (image processing reads walls, not furniture). Items are fitted
// into the largest clear rectangle of the room, against the wall farthest from a door, and kept clear of doors.
import { inside, type PlanFurniture, type PlanRoom, type Pt } from '@/lib/layout';

type Rect = { x0: number; z0: number; x1: number; z1: number };
type Side = { o: [number, number]; a: [number, number]; n: [number, number]; len: number; depth: number; rot: number };
type Door = { x: number; z: number; w: number };
type Item = { kind: string; x: number; z: number; w: number; d: number; rot: number };

const CELL = 0.1; // metres

/** Largest axis-aligned rectangle of grid cells inside the polygon (metres). */
function clearRect(poly: Pt[]): Rect | null {
  const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
  const X0 = Math.min(...xs), Z0 = Math.min(...zs);
  const C = Math.ceil((Math.max(...xs) - X0) / CELL), R = Math.ceil((Math.max(...zs) - Z0) / CELL);
  if (C < 3 || R < 3 || C * R > 400_000) return null;
  const h = new Array(C).fill(0);
  let best = 0, rect: Rect | null = null;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) h[c] = inside(poly, X0 + (c + 0.5) * CELL, Z0 + (r + 0.5) * CELL) ? h[c] + 1 : 0;
    const st: number[] = [];
    for (let c = 0; c <= C; c++) {
      const cur = c < C ? h[c] : 0;
      while (st.length && h[st[st.length - 1]] >= cur) {
        const top = st.pop()!, height = h[top], left = st.length ? st[st.length - 1] + 1 : 0, area = height * (c - left);
        if (area > best && height > 0) { best = area; rect = { x0: X0 + left * CELL, x1: X0 + c * CELL, z0: Z0 + (r - height + 1) * CELL, z1: Z0 + (r + 1) * CELL }; }
      }
      st.push(c);
    }
  }
  return rect && { x0: rect.x0 + 0.05, z0: rect.z0 + 0.05, x1: rect.x1 - 0.05, z1: rect.z1 - 0.05 };
}

function sides(r: Rect): Side[] {
  const wx = r.x1 - r.x0, wz = r.z1 - r.z0;
  return [
    { o: [r.x0, r.z0], a: [1, 0], n: [0, 1], len: wx, depth: wz, rot: 0 },               // top wall, items face down
    { o: [r.x1, r.z1], a: [-1, 0], n: [0, -1], len: wx, depth: wz, rot: Math.PI },        // bottom wall
    { o: [r.x0, r.z1], a: [0, -1], n: [1, 0], len: wz, depth: wx, rot: Math.PI / 2 },     // left wall, items face right
    { o: [r.x1, r.z0], a: [0, 1], n: [-1, 0], len: wz, depth: wx, rot: -Math.PI / 2 },    // right wall
  ];
}
const opposite = (i: number) => [1, 0, 3, 2][i];
const across = (i: number) => (i < 2 ? [2, 3] : [0, 1]);

/** Centre of an item `along` metres along a side, `off` metres out from the wall to its back. */
function at(s: Side, along: number, off: number, w: number, d: number, kind: string, turn = 0): Item {
  return { kind, x: s.o[0] + s.a[0] * along + s.n[0] * (off + d / 2), z: s.o[1] + s.a[1] * along + s.n[1] * (off + d / 2), w, d, rot: s.rot + turn };
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

/** Item footprint corners, for the fit tests. */
function corners(it: Item): [number, number][] {
  const c = Math.cos(it.rot), s = Math.sin(it.rot);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const lx = (u * it.w) / 2, lz = (v * it.d) / 2;
    return [it.x + lx * c + lz * s, it.z - lx * s + lz * c];
  });
}

export function furnishRoom(room: PlanRoom, doors: Door[], W: number, H: number): Item[] {
  const poly: Pt[] = room.pts.map(([x, y]) => [x * W, y * H]);
  const r = clearRect(poly);
  if (!r) return [];
  const S = sides(r);
  const wx = r.x1 - r.x0, wz = r.z1 - r.z0, area = wx * wz;
  const near = doors.filter(d => inside(poly, d.x, d.z) || poly.some((p, i) => segDist(d.x, d.z, p[0], p[1], poly[(i + 1) % poly.length][0], poly[(i + 1) % poly.length][1]) < 0.4));
  // the main wall: farthest from any door; ties go to the longer wall
  const score = (s: Side) => {
    const b: [number, number] = [s.o[0] + s.a[0] * s.len, s.o[1] + s.a[1] * s.len];
    const dd = near.length ? Math.min(...near.map(d => segDist(d.x, d.z, s.o[0], s.o[1], b[0], b[1]))) : 99;
    return Math.min(dd, 3) + s.len * 0.05;
  };
  const order = [0, 1, 2, 3].sort((i, j) => score(S[j]) - score(S[i]));
  const mi = order[0], M = S[mi];
  const out: Item[] = [];
  const ok = (it: Item) => corners(it).every(([x, z]) => inside(poly, x, z)) &&
    near.every(d => corners(it).concat([[it.x, it.z]]).every(([x, z]) => Math.hypot(x - d.x, z - d.z) > Math.max(0.75, d.w * 0.95))) &&
    out.every(o => Math.hypot(o.x - it.x, o.z - it.z) > (Math.min(o.w, o.d) + Math.min(it.w, it.d)) / 2 * 0.9 || o.kind === 'table' && it.kind === 'sink');
  const put = (it: Item) => { if (ok(it)) { out.push(it); return true; } return false; };
  const corner = (kind: string, size: number) => {
    for (const s of [S[opposite(mi)], ...across(mi).map(i => S[i])]) {
      if (put(at(s, 0.1 + size / 2, 0.05, size, size, kind)) || put(at(s, s.len - 0.1 - size / 2, 0.05, size, size, kind))) return;
    }
  };
  /** A table with chairs on its two long sides (and ends if there is room). */
  const tableSet = (cx: number, cz: number, len: number, wid: number, alongX: boolean, kind = 'table', ends = true) => {
    const rot = alongX ? 0 : Math.PI / 2;
    if (!put({ kind, x: cx, z: cz, w: len, d: wid, rot })) return;
    const n = Math.max(1, Math.floor(len / 0.65));
    for (let k = 0; k < n; k++) {
      const u = -len / 2 + (k + 0.5) * (len / n);
      for (const side of [-1, 1]) {
        const off = wid / 2 + 0.3;
        const [x, z] = alongX ? [cx + u, cz + side * off] : [cx + side * off, cz + u];
        // chairs face the table
        const face = alongX ? (side < 0 ? 0 : Math.PI) : (side < 0 ? Math.PI / 2 : -Math.PI / 2);
        put({ kind: 'chair', x, z, w: 0.45, d: 0.45, rot: face });
      }
    }
    if (ends) for (const side of [-1, 1]) {
      const off = len / 2 + 0.3;
      const [x, z] = alongX ? [cx + side * off, cz] : [cx, cz + side * off];
      const face = alongX ? (side < 0 ? Math.PI / 2 : -Math.PI / 2) : (side < 0 ? 0 : Math.PI);
      put({ kind: 'chair', x, z, w: 0.45, d: 0.45, rot: face });
    }
  };
  /** Rows of a repeated unit (pitch along x and z) over the clear rectangle, keeping an aisle at the edges. */
  const rows = (make: (x: number, z: number) => void, px: number, pz: number, margin = 0.6) => {
    const nx = Math.floor((wx - 2 * margin) / px), nz = Math.floor((wz - 2 * margin) / pz);
    if (nx < 1 || nz < 1) return;
    const ox = r.x0 + (wx - nx * px) / 2 + px / 2, oz = r.z0 + (wz - nz * pz) / 2 + pz / 2;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) make(ox + i * px, oz + j * pz);
  };
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, longX = wx >= wz;
  const name = `${room.name} ${room.label ?? ''}`.toLowerCase();
  const is = (re: RegExp) => re.test(name);

  if (is(/stair|steps/)) {
    put({ kind: 'stair', x: cx, z: cz, w: Math.min(longX ? wz : wx, 1.6) - 0.1, d: (longX ? wx : wz) * 0.8, rot: longX ? Math.PI / 2 : 0 });
  } else if (is(/bath|toilet|wc|shower|ensuite|en-suite|powder|lavatory|restroom|washroom|ablution/)) {
    put(at(M, Math.min(0.5, M.len / 4), 0.02, 0.42, 0.7, 'toilet'));
    put(at(M, M.len - 0.45, 0.02, 0.6, 0.45, 'sink')) || put(at(S[across(mi)[0]], S[across(mi)[0]].len / 2, 0.02, 0.6, 0.45, 'sink'));
    if (area >= 3.2) for (const s of [S[opposite(mi)], ...across(mi).map(i => S[i])]) if (put(at(s, 0.5, 0.02, 0.9, 0.9, 'shower'))) break;
  } else if (is(/kitchen|kitchenette|pantry|galley/)) {
    const run = Math.min(M.len - 0.1, 4.2);
    const start = (M.len - run) / 2;
    const n = Math.max(1, Math.round(run / 0.6));
    const seg = run / n, sinkAt = Math.floor(n / 2);
    for (let k = 0; k < n; k++) put(at(M, start + (k + 0.5) * seg, 0.0, seg, 0.6, k === sinkAt ? 'sink' : 'counter'));
    const side = S[across(mi)[0]];
    if (side.len > 2.4 && M.depth > 2.6) for (let k = 0; k < Math.floor((side.len - 1.2) / 0.6); k++) put(at(side, 0.9 + k * 0.6, 0, 0.6, 0.6, 'counter'));
    if (area > 11) tableSet(cx + M.n[0] * 0.6, cz + M.n[1] * 0.6, 1.2, 0.8, longX);
  } else if (is(/dining|breakfast/) && !is(/living|lounge|family/)) {
    const len = Math.min((longX ? wx : wz) - 1.6, 2.2), wid = Math.min((longX ? wz : wx) - 1.6, 1.0);
    if (len > 0.8 && wid > 0.6) tableSet(cx, cz, len, wid, longX);
    corner('cabinet', 0.5);
  } else if (is(/master|bed|guest|kids|nursery|sleep|dorm/)) {
    const double = M.len >= 2.6 && !is(/kids|nursery|single/);
    const bw = double ? 1.6 : 0.95, bd = 2.05, mid = M.len / 2;
    if (put(at(M, mid, 0.02, bw, bd, 'bed'))) {
      put(at(M, mid - bw / 2 - 0.3, 0.02, 0.45, 0.4, 'cabinet'));
      if (double) put(at(M, mid + bw / 2 + 0.3, 0.02, 0.45, 0.4, 'cabinet'));
    }
    const wardrobe = Math.min(2.0, S[opposite(mi)].len - 0.6);
    if (M.depth > bd + 1.4 && wardrobe > 0.8) put(at(S[opposite(mi)], S[opposite(mi)].len / 2, 0.02, wardrobe, 0.6, 'cabinet'));
    else for (const i of across(mi)) if (put(at(S[i], S[i].len - 0.9, 0.02, Math.min(1.6, S[i].len / 2), 0.6, 'cabinet'))) break;
    if (area > 12) { const s = S[across(mi)[1]]; put(at(s, s.len / 2, 0.02, 1.1, 0.55, 'desk')) && put(at(s, s.len / 2, 0.75, 0.5, 0.5, 'task_chair', Math.PI)); }
    corner('plant', 0.4);
  } else if (is(/living|lounge|family|sitting|great room|tv|media|den\b|common/)) {
    const combo = is(/dining/) && M.len >= 5.5;        // long living / dining room: lounge at one end, table at the other
    const u0 = combo ? M.len * 0.3 : M.len / 2;
    const sw = Math.min(2.3, (combo ? M.len * 0.5 : M.len) - 1.2);
    if (sw > 1.2) {
      put(at(M, u0, 0.05, sw, 0.9, 'sofa'));
      put(at(M, u0, 1.35, Math.min(1.1, sw * 0.55), 0.55, 'table'));
      if (combo) put(at(M, Math.max(0.5, u0 - sw / 2 - 0.55), 1.0, 0.8, 0.8, 'armchair', -Math.PI / 2));
      else for (const [i, u] of across(mi).map((i, k) => [i, k] as const)) {
        const s = S[i];
        // armchairs on the side walls, level with the coffee table, facing in
        const along = u === 0 ? s.len - 1.6 : 1.6;
        put(at(s, Math.max(0.5, Math.min(s.len - 0.5, along)), 0.1, 0.8, 0.8, 'armchair'));
      }
      const o = S[opposite(mi)];
      const tableAt = (c: Item, len: number, alongX: boolean) => { const before = out.length; tableSet(c.x, c.z, len, 0.9, alongX); return out.length > before; };
      if (combo) {
        const len = Math.min(1.8, M.len * 0.3);
        for (const f of [0.78, 0.72, 0.84]) if (tableAt(at(M, M.len * f, Math.max(1.1, M.depth / 2 - 0.45), len, 0.9, 'table'), len, M.a[0] !== 0)) break;
      } else if (is(/dining/) && M.depth > 5) {
        // the dining table takes the far half of the room; try along the wall, doors often sit in it
        const len = Math.min(o.len - 1.8, 1.8);
        if (len > 0.9) for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) if (tableAt(at(o, o.len * f, 1.1, len, 0.9, 'table'), len, o.a[0] !== 0)) break;
      } else if (M.depth > 3.2) put(at(o, o.len / 2, 0.02, Math.min(1.8, o.len - 1), 0.45, 'cabinet'));
    }
    corner('plant', 0.45);
  } else if (is(/study|office|cabin|work ?room|home office|library/) && area < 25) {
    if (put(at(M, M.len / 2, 0.02, Math.min(1.6, M.len - 0.4), 0.75, 'desk'))) put(at(M, M.len / 2, 0.95, 0.55, 0.55, 'task_chair', Math.PI));
    for (const i of across(mi)) if (put(at(S[i], S[i].len - 0.7, 0.02, 1.0, 0.35, 'shelf'))) break;
    if (area > 9) { const o = S[opposite(mi)]; put(at(o, o.len / 2, 0.05, 1.6, 0.8, 'sofa')); }
    corner('plant', 0.4);
  } else if (is(/meeting|conference|board|discussion|huddle/)) {
    const len = (longX ? wx : wz) - 1.8, wid = Math.min(1.2, (longX ? wz : wx) - 1.8);
    if (len > 1 && wid > 0.7) tableSet(cx, cz, len, wid, longX, 'table', false);
    const end = longX ? S[2] : S[0];
    put(at(end, end.len / 2, 0.02, Math.min(1.8, end.len - 0.6), 0.12, 'screen'));
  } else if (is(/training|class|lecture|seminar|auditorium/)) {
    const front = M;
    put(at(front, front.len / 2, 0.02, Math.min(2.4, front.len - 0.6), 0.12, 'screen'));
    const f = front.n;
    // rows of two-seat tables facing the screen
    for (let row = 0; ; row++) {
      const dist = 1.8 + row * 1.5;
      if (dist + 0.9 > front.depth) break;
      for (let u = 0.9; u + 0.7 < front.len; u += 1.6) {
        const t = at(front, u + 0.6, dist, 1.2, 0.5, 'table');
        if (put(t)) for (const s of [-0.3, 0.3]) put({ kind: 'chair', x: t.x + front.a[0] * s + f[0] * 0.55, z: t.z + front.a[1] * s + f[1] * 0.55, w: 0.45, d: 0.45, rot: front.rot + Math.PI });
      }
    }
  } else if (is(/cafeteria|canteen|cafe|café|restaurant|dining hall|food court|break ?room/)) {
    rows((x, z) => {
      if (!put({ kind: 'round_table', x, z, w: 0.8, d: 0.8, rot: 0 })) return;
      for (const [dx, dz, rot] of [[0, -0.65, 0], [0, 0.65, Math.PI], [-0.65, 0, Math.PI / 2], [0.65, 0, -Math.PI / 2]] as const) put({ kind: 'chair', x: x + dx, z: z + dz, w: 0.45, d: 0.45, rot });
    }, 2.2, 2.2, 0.5);
    put(at(M, M.len / 2, 0, Math.min(3, M.len - 1), 0.6, 'counter'));
  } else if (is(/workspace|open office|open plan|work ?area|zone|office|desk|studio|lab\b/)) {
    // desk pairs facing each other, 1.6 m deep per pair plus a 1.2 m aisle
    rows((x, z) => {
      for (const side of [-1, 1]) {
        const dz = side * 0.4, rot = side < 0 ? Math.PI : 0;
        const [px, pz] = longX ? [x, z + dz] : [x + dz, z];
        if (put({ kind: 'desk', x: px, z: pz, w: 1.4, d: 0.7, rot: longX ? rot : rot + Math.PI / 2 }))
          put({ kind: 'task_chair', x: longX ? px : px + side * 0.65, z: longX ? pz + side * 0.65 : pz, w: 0.55, d: 0.55, rot: longX ? rot + Math.PI : rot - Math.PI / 2 });
      }
    }, longX ? 1.6 : 3.0, longX ? 3.0 : 1.6, 0.8);
  } else if (is(/laundry|utility|wash ?room|mud/)) {
    put(at(M, 0.4, 0.02, 0.6, 0.6, 'cabinet'));
    put(at(M, 1.05, 0.02, 0.6, 0.6, 'cabinet'));
    put(at(M, M.len - 0.6, 0, 0.9, 0.6, 'sink'));
    for (const i of across(mi)) if (put(at(S[i], S[i].len / 2, 0.02, Math.min(1.6, S[i].len - 1.2), 0.4, 'shelf'))) break;
  } else if (is(/store|storage|closet|wardrobe|walk-in|archive|server|hub|it room|electrical|plant room/)) {
    const kind = is(/server|hub|it room/) ? 'rack' : is(/electrical/) ? 'elec_panel' : 'shelf';
    for (const i of [mi, opposite(mi)]) { const s = S[i]; for (let u = 0.6; u + 0.5 < s.len; u += 1.1) put(at(s, u, 0.02, 1.0, kind === 'rack' ? 0.8 : 0.4, kind)); }
  } else if (is(/gym|fitness|exercise/)) {
    for (let u = 0.6; u + 0.5 < M.len; u += 1.2) put(at(M, u, 0.3, 0.8, 1.9, 'treadmill', Math.PI));
    const o = S[opposite(mi)];
    put(at(o, 0.9, 0.2, 1.2, 0.6, 'weight_rack'));
    put(at(o, 2.4, 0.4, 0.5, 1.3, 'bench'));
    for (let u = o.len - 0.6; u > 3.2; u -= 1.0) put(at(o, u, 0.3, 0.6, 1.2, 'bike'));
  } else if (is(/locker|changing|dressing/)) {
    for (let u = 0.3; u + 0.3 < M.len; u += 0.62) put(at(M, u, 0.02, 0.6, 0.5, 'locker'));
    put(at(M, M.len / 2, 0.9, Math.min(1.6, M.len - 0.6), 0.4, 'bench'));
  } else if (is(/reception|lobby|foyer|entry|entrance|waiting/)) {
    if (area > 8) put(at(M, M.len / 2, 0.05, Math.min(2.0, M.len - 1), 0.7, 'counter'));
    const o = S[opposite(mi)];
    if (area > 12) put(at(o, o.len / 2, 0.05, Math.min(2.2, o.len - 1.2), 0.85, 'sofa'));
    corner('plant', 0.45);
  } else if (is(/medical|clinic|first aid|nurse|sick|maternity/)) {
    put(at(M, M.len / 2, 0.02, 0.95, 2.0, 'bed'));
    const o = S[opposite(mi)];
    put(at(o, o.len / 2, 0.02, 1.2, 0.6, 'desk')) && put(at(o, o.len / 2, 0.8, 0.5, 0.5, 'task_chair', Math.PI));
    corner('cabinet', 0.5);
  } else if (is(/balcony|terrace|patio|deck|veranda|porch/)) {
    if (area > 3) {
      put({ kind: 'round_table', x: cx, z: cz, w: 0.7, d: 0.7, rot: 0 });
      put({ kind: 'chair', x: longX ? cx - 0.6 : cx, z: longX ? cz : cz - 0.6, w: 0.45, d: 0.45, rot: longX ? Math.PI / 2 : 0 });
      put({ kind: 'chair', x: longX ? cx + 0.6 : cx, z: longX ? cz : cz + 0.6, w: 0.45, d: 0.45, rot: longX ? -Math.PI / 2 : Math.PI });
    }
    corner('plant', 0.45);
  } else if (is(/hall|corridor|passage|landing|lift|elevator/)) {
    if (Math.min(wx, wz) > 1.4) corner('plant', 0.4);
  }
  return out;
}

/** Suggested interiors for every room, in plan fractions. Rooms that already hold detected items are left alone. */
export function furnish(rooms: PlanRoom[], existing: PlanFurniture[], doorItems: PlanFurniture[], widthM: number, aspect: number): PlanFurniture[] {
  const W = widthM, H = widthM * aspect;
  const doors: Door[] = doorItems.map(d => ({ x: d.fx * W, z: d.fy * H, w: d.fw * W }));
  const out: PlanFurniture[] = [];
  for (const room of rooms) {
    const has = existing.some(f => f.kind !== 'door' && inside(room.pts, f.fx, f.fy));
    if (has) continue;
    for (const it of furnishRoom(room, doors, W, H))
      out.push({ kind: it.kind, fx: +(it.x / W).toFixed(5), fy: +(it.z / H).toFixed(5), fw: +(it.w / W).toFixed(5), fd: +(it.d / W).toFixed(5), rot: +it.rot.toFixed(4), suggested: true });
  }
  return out;
}
