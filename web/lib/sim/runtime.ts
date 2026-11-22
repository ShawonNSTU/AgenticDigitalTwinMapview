// Runtime state of the simulated device platform: scenario, clock and device overrides.
// Kept on globalThis so it survives hot reloads in development. One process = one demo.
import { sheet4F } from './sheet4f';
import { DEV, SCEN, TYPES, ROOMS, byId, snapshot, state as engineState, health, LBL, LAYOUT, setLayout, setDevices, scenarioName, scenarioAvailable, activeFault } from './engine';
import building from './data/building.json';
import sampleDevices from './data/devices.json';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { roomColor, roomKey, toBuilding, MOUNT, PREFIX, insideXZ, type PlanRoom, type Pt } from '@/lib/layout';
import { fitSmartThingsZone } from './stzone';
import { realState, link as stLink, hsvHex } from '@/lib/integrations/smartthings';
import { ensureLive } from '@/lib/integrations/stlive';
import { log as journal, resetJournal } from '@/lib/kg/journal';


type Override = Record<string, unknown>;
interface Runtime {
  t: number; // scene time in hours (6..22)
  playing: boolean;
  speed: number; // simulated hours per real second
  lastTick: number; // ms
  overrides: Record<string, Override>; // per-device values set by commands
  log: { at: number; deviceId: string; command: string; args: unknown; by: string }[];
  plan: { bytes: Buffer; mime: string; x0: number; x1: number; z0: number; z1: number } | null; // uploaded floor plan image
  furniture: { kind: string; x: number; z: number; w: number; d: number; rot?: number; h?: number }[]; // interiors from the plan
  notes: Note[]; // other text printed on the plan (zone tags, SCREEN, UP/DN, dimensions)
  title: string; // floor name shown in the header
  planGen?: number; // bumps when a new plan is uploaded or the sample is restored (guest links made before stop working)
  floor?: 'none' | 'preset' | 'upload'; // none: no plan uploaded yet, the app asks for one
}
export type Note = { text: string; x: number; z: number; size?: number; rot?: number };
const g = globalThis as unknown as { __twin?: Runtime };
export const rt: Runtime = (g.__twin ??= { t: 10, playing: false, speed: 0.5, lastTick: Date.now(), overrides: {}, log: [], plan: null, furniture: [], notes: [], title: 'Sample home' });
rt.furniture ??= [];
rt.notes ??= [];
rt.title ??= 'Sample home';
rt.floor ??= 'none';

/** Advance the clock if playing. Called by every request and by the event stream. */
export function tick(): number {
  const now = Date.now();
  if (rt.playing) {
    rt.t += ((now - rt.lastTick) / 1000) * rt.speed;
    if (rt.t > 22) { rt.t = 22; rt.playing = false; }
  }
  rt.lastTick = now;
  return rt.t;
}

export function simState() {
  return { t: +rt.t.toFixed(3), playing: rt.playing, speed: rt.speed, scenario: engineState.scen, fixT: engineState.fixT, scenarios: Object.keys(SCEN).map(key => ({ key, name: scenarioName(key), available: scenarioAvailable(key) })) };
}

export function setSim(p: { scenario?: string; t?: number; playing?: boolean; speed?: number; fix?: boolean }) {
  if (p.scenario && p.scenario in SCEN && scenarioAvailable(p.scenario)) { engineState.scen = p.scenario; engineState.fixT = null; rt.overrides = {}; }
  if (typeof p.t === 'number') rt.t = Math.max(6, Math.min(22, p.t));
  if (typeof p.playing === 'boolean') rt.playing = p.playing;
  if (typeof p.speed === 'number') rt.speed = Math.max(0.05, Math.min(5, p.speed));
  if (p.fix) engineState.fixT = rt.t;
  if (p.scenario || typeof p.t === 'number') journal({ kind: 'sim', text: `Simulation: scenario ${scenarioName(engineState.scen)}, time ${String(Math.floor(rt.t)).padStart(2, '0')}:${String(Math.round((rt.t % 1) * 60)).padStart(2, '0')}` });
  rt.lastTick = Date.now();
  return simState();
}

/** Device snapshot with command overrides applied on top of simulated readings. */
export function device(id: string, t = tick()) {
  let o = rt.overrides[id] ?? null;
  const d = byId[id];
  if (d?.type === 'ac' && o?.timer && o?.timerAt && Date.now() > Number(o.timerAt) + Number(o.timer) * 3600_000) {
    rt.overrides[id] = o = { ...o, on: false, timer: 0, timerAt: undefined }; // off-timer ran out
  }
  if (d?.type === 'ac' && acDyn[id]) {
    const base = snapshot(id, t, null);
    const room = base ? acRoom(id, base.readings as Record<string, any>, o) : null;
    if (room != null) o = { ...(o ?? {}), room };
  }
  // a device linked to SmartThings shows what the real device reports (over the simulated values)
  const real = d ? realState(id, d.type) : null;
  if (real) o = { ...(o ?? {}), ...real.readings, ...(real.online ? {} : { online: false }) };
  const s = snapshot(id, t, o);
  if (!s) return null;
  // which values the real device reported (the rest, and every component value, is simulated)
  return { ...s, overrides: rt.overrides[id] ?? null, online: (s.readings as any).online !== false, source: real ? 'smartthings' : 'simulator', reported: real ? Object.keys(real.readings) : [] };
}

/** Readings the floor view needs for every refrigerant circuit, sent with each /api/floor poll. */
const LIVE: Record<string, string[]> = {
  ac: ['on', 'fan', 'air', 'evIn', 'evOut', 'sh', 'room', 'set', 'mode', 'swing', 'online'], odu: ['hz', 'dis', 'suc', 'lp', 'hp', 'fan'],
  light: ['lv', 'ct', 'col', 'online'], tv: ['on', 'vol', 'input', 'online'], fan: ['on', 'speed', 'osc', 'online'], blinds: ['pos', 'online'],
  purifier: ['on', 'fan', 'pm', 'online'], vacuum: ['state', 'batt', 'online'], lock: ['locked', 'online'], plug: ['on', 'online'],
  temphum: ['temp', 'hum', 'online'],
};
function live(id: string, t: number) {
  const d = device(id, t)!;
  return Object.fromEntries(LIVE[d.type].map(k => [k, (d.readings as Record<string, unknown>)[k]]));
}

export function floor(t = tick()) {
  ensureLive();   // linked SmartThings devices are read in the background (lib/integrations/stlive.ts)
  return {
    time: t,
    scenario: engineState.scen,
    layoutVersion: LAYOUT.version,
    devicesVersion: LAYOUT.devVersion,
    rooms: ROOMS,
    devices: DEV.map(d => { const h = health(d, t); return { id: d.id, type: d.type, label: TYPES[d.type].label, room: d.room, name: d.name, position: d.p, rotationY: d.rotationY, ...((d as any).fixture ? { fixture: (d as any).fixture } : {}), ...(stLink(d.id) ? { real: true } : {}), health: h, healthLabel: LBL[h], ...(activeFault(d) ? { fault: activeFault(d)!.spec.name } : {}), ...(LIVE[d.type] ? { live: live(d.id, t) } : {}) }; }),
  };
}

/* ---------------- device commands ---------------- */
// Whitelisted commands per device type. `confirm` commands must be confirmed by the user first
// (the agent asks; the API rejects them unless confirmed=true).
/** Colour presets for colour bulbs (hex as the 3D view shows them). */
export const LIGHT_COLORS: Record<string, string> = { pink: '#ff6fae', purple: '#8b5cf6', blue: '#3b82f6', cyan: '#22d3ee', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };

// `hidden`: run by integrations (the SmartThings agent), not offered as a control in the panels
export const COMMANDS: Record<string, Record<string, { args?: Record<string, [number, number] | string[]>; confirm?: boolean; hidden?: boolean; apply: (a: any, cur: any) => Override }>> = {
  ac: {
    power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) },
    setTemperature: { args: { celsius: [16, 30] }, apply: a => ({ set: +a.celsius }) },
    setMode: { args: { mode: ['cool', 'heat', 'dry', 'fan', 'auto'] }, apply: a => ({ mode: String(a.mode), on: true }) },
    setFanSpeed: { args: { percent: [0, 100] }, apply: a => ({ fan: +a.percent }) },
    setSwing: { args: { position: ['swing', 'up', 'middle', 'down'] }, apply: a => ({ swing: String(a.position) }) },
    setTimer: { args: { hours: [0, 12] }, apply: a => ({ timer: +a.hours, timerAt: Date.now() }) },
  },
  light: {
    power: { args: { on: ['true', 'false'] }, apply: (a, cur) => (a.on === true || a.on === 'true') ? { lv: cur?.lastLv || 80 } : { lv: 0, lastLv: cur?.lv || 80 } },
    setLevel: { args: { percent: [0, 100] }, apply: a => ({ lv: +a.percent }) },
    setColorTemperature: { args: { kelvin: [2200, 6500] }, apply: a => ({ ct: +a.kelvin, col: '' }) },
    // colour bulbs: a named colour (the SmartThings app's colour presets); white comes back with setColorTemperature
    setColor: { args: { color: Object.keys(LIGHT_COLORS) }, apply: a => ({ col: LIGHT_COLORS[String(a.color)] ?? '' }) },
    // any colour, as SmartThings colorControl gives it (hue and saturation 0-100)
    setHueSat: { args: { hue: [0, 100], saturation: [0, 100] }, hidden: true, apply: a => ({ col: Number(a.saturation) < 3 ? '' : hsvHex(Number(a.hue), Number(a.saturation)) }) },
  },
  tv: {
    power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) },
    setVolume: { args: { percent: [0, 100] }, apply: a => ({ vol: +a.percent }) },
    setInput: { args: { source: ['TV', 'HDMI 1', 'HDMI 2', 'Apps'] }, apply: a => ({ input: String(a.source), on: true }) },
  },
  fan: {
    power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) },
    setSpeed: { args: { level: [1, 3] }, apply: a => ({ speed: +a.level, on: true }) },
    setOscillation: { args: { on: ['true', 'false'] }, apply: a => ({ osc: a.on === true || a.on === 'true' }) },
  },
  blinds: {
    open: { apply: () => ({ pos: 100 }) },
    close: { apply: () => ({ pos: 0 }) },
    setPosition: { args: { percent: [0, 100] }, apply: a => ({ pos: +a.percent }) },
  },
  plug: { power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) } },
  lock: {
    lock: { apply: () => ({ locked: true }) },
    unlock: { confirm: true, apply: () => ({ locked: false, unlockedAt: Date.now() }) },
  },
  washer: { stop: { confirm: true, apply: () => ({ state: 'Stopped by user' }) } },
  purifier: {
    power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) },
    setFan: { args: { level: [1, 5] }, apply: a => ({ fan: +a.level, on: true }) },
  },
  vacuum: { start: { apply: () => ({ state: 'Cleaning', startedAt: Date.now() }) }, dock: { apply: () => ({ state: 'Docked' }) } },
};

/* The room answers an AC slowly: after a command the room temperature moves from where it was toward what
   the unit can reach (setpoint when cooling below the room or heating above it), with a ~45 s time constant,
   so a guest sees the room cool down live. Off, fan and dry drift back to the room's own temperature. */
type AcDyn = { room0: number; at: number };
const acDyn: Record<string, AcDyn> = ((globalThis as any).__acDyn ??= {});
const TAU_MS = 45_000;
function acRoom(id: string, base: Record<string, any>, o: Override | null) {
  const dyn = acDyn[id];
  if (!dyn) return null;
  const on = (o?.on ?? base.on) !== false, mode = String(o?.mode ?? 'cool'), set = Number(o?.set ?? base.set);
  const ambient = Number(base.room);
  let target = ambient;
  if (on && (mode === 'cool' || mode === 'auto') && set < ambient) target = set;
  if (on && (mode === 'heat' || mode === 'auto') && set > ambient) target = set;
  if (on && mode === 'dry') target = ambient - 0.8;
  if (on && mode === 'fan') target = ambient - 0.3;
  const k = Math.exp(-(Date.now() - dyn.at) / TAU_MS);
  return +(target + (dyn.room0 - target) * k).toFixed(2);
}

export function runCommand(id: string, command: string, args: Record<string, unknown> = {}, confirmed = false, by = 'user') {
  const d = byId[id];
  if (!d) return { ok: false, error: `Unknown device ${id}` };
  const spec = COMMANDS[d.type]?.[command];
  if (!spec) return { ok: false, error: `${TYPES[d.type].label} does not support "${command}". Supported: ${Object.keys(COMMANDS[d.type] ?? {}).join(', ') || 'none'}` };
  if (spec.confirm && !confirmed) return { ok: false, needsConfirmation: true, error: `"${command}" on ${id} needs explicit confirmation` };
  if (activeFault(d)?.spec.key === 'offline') return { ok: false, offline: true, error: `${TYPES[d.type].label} ${id} is offline and did not respond` };
  for (const [k, rule] of Object.entries(spec.args ?? {})) {
    const v = args[k];
    if (v === undefined) return { ok: false, error: `Missing argument "${k}"` };
    if (Array.isArray(rule) && typeof rule[0] === 'number') { const n = Number(v); if (Number.isNaN(n) || n < (rule[0] as number) || n > (rule[1] as number)) return { ok: false, error: `"${k}" must be between ${rule[0]} and ${rule[1]}` }; }
    else if (Array.isArray(rule) && !rule.map(String).includes(String(v))) return { ok: false, error: `"${k}" must be one of ${rule.join(', ')}` };
  }
  const before = device(id);
  if (d.type === 'ac' && before) acDyn[id] = { room0: Number((before.readings as any)?.room), at: Date.now() };
  rt.overrides[id] = { ...(rt.overrides[id] ?? {}), ...spec.apply(args, { ...(before?.readings ?? {}), ...(rt.overrides[id] ?? {}) }) };
  rt.log.push({ at: rt.t, deviceId: id, command, args, by });
  return { ok: true, device: device(id) };
}

/* ---------------- devices placed on the floor (drag and drop) ---------------- */

const plain = (d: any) => ({ id: d.id, type: d.type, room: d.room, name: d.name, position: d.p, rotationY: d.rotationY ?? 0, ...(d.fixture ? { fixture: d.fixture } : {}) });

/** Room containing a point (metres), by polygon. Outside every room → 'out'. */
export function roomAtXZ(x: number, z: number) {
  return ROOMS.find((r: any) => r.poly ? insideXZ(r.poly, x, z) : x >= r.x[0] && x <= r.x[1] && z >= r.z[0] && z <= r.z[1]) ?? null;
}

function nextDeviceId(type: string) {
  const p = PREFIX[type] ?? type.slice(0, 2).toUpperCase();
  let n = 1;
  while (byId[`${p}-${String(n).padStart(2, '0')}`]) n++;
  return `${p}-${String(n).padStart(2, '0')}`;
}

/** Add a device at (x, z) metres. Mount height comes from the type unless y is given. */
/** `fixture`: how the device is fitted, for the 3D view (spot, wall, lamp, desk, panel, window, roller); optional. */
export function addDevice(p: { type: string; x: number; z: number; y?: number; rotationY?: number; room?: string; name?: string; id?: string; fixture?: string }) {
  if (!(p.type in TYPES)) return { ok: false as const, error: `Unknown device type "${p.type}"` };
  if (p.id && byId[p.id]) return { ok: false as const, error: `Device ${p.id} already exists` };
  const id = p.id ?? nextDeviceId(p.type);
  const room = (p.room && ROOMS.find((r: any) => r.key === p.room)) || roomAtXZ(p.x, p.z);
  const label = TYPES[p.type].label;
  const d = { id, type: p.type, room: room?.key ?? 'out', name: `${p.name ?? label} · ${room?.name ?? 'Outside'}`, position: [+p.x.toFixed(3), +(p.y ?? MOUNT[p.type] ?? 1).toFixed(3), +p.z.toFixed(3)], rotationY: +(p.rotationY ?? 0).toFixed(4), ...(p.fixture ? { fixture: p.fixture } : {}) };
  setDevices([...DEV.map(plain), d]);
  journal({ kind: 'device', devices: [id], room: d.room, text: `${label} ${id} placed in ${room?.name ?? 'Outside'}` });
  return { ok: true as const, device: d };
}

export function moveDevice(id: string, p: { x?: number; z?: number; y?: number; rotationY?: number }) {
  const cur = byId[id];
  if (!cur) return { ok: false as const, error: `Unknown device ${id}` };
  const x = p.x ?? cur.p[0], z = p.z ?? cur.p[2];
  const room = roomAtXZ(x, z);
  const label = TYPES[cur.type].label;
  const next = { ...plain(cur), room: room?.key ?? 'out', name: room?.key === cur.room ? cur.name : `${label} · ${room?.name ?? 'Outside'}`, position: [x, p.y ?? cur.p[1], z], rotationY: p.rotationY ?? cur.rotationY ?? 0 };
  setDevices(DEV.map(d => d.id === id ? next : plain(d)));
  if (room?.key !== cur.room) journal({ kind: 'device', devices: [id], room: room?.key ?? 'out', text: `${String(cur.name).split(' · ')[0]} ${id} moved to ${room?.name ?? 'Outside'}` });
  return { ok: true as const, device: next };
}

/** Give a device a new name (kept with its room, "Name · Room"), e.g. the label of the real device it now stands for. */
export function renameDevice(id: string, label: string) {
  const cur = byId[id];
  if (!cur) return { ok: false as const, error: `Unknown device ${id}` };
  const room = ROOMS.find((r: any) => r.key === cur.room) as any;
  journal({ kind: 'device', devices: [id], room: cur.room, text: `${String(cur.name).split(' · ')[0]} ${id} renamed to ${label}` });
  setDevices(DEV.map(d => d.id === id ? { ...plain(d), name: `${label} · ${room?.name ?? 'Outside'}` } : plain(d)));
  return { ok: true as const };
}

export function removeDevice(id: string) {
  if (!byId[id]) return { ok: false as const, error: `Unknown device ${id}` };
  journal({ kind: 'device', devices: [id], room: byId[id].room, text: `${String(byId[id].name).split(' · ')[0]} ${id} removed` });
  setDevices(DEV.filter(d => d.id !== id).map(plain));
  delete rt.overrides[id];
  return { ok: true as const };
}

/* ---------------- building layout (floor plan upload) ---------------- */

/** Static layout for the renderer: rooms, device placements and the plan image bounds. */
export function buildingState() {
  return {
    version: LAYOUT.version,
    devicesVersion: LAYOUT.devVersion,
    custom: LAYOUT.custom,
    wallHeight: LAYOUT.wallHeight,
    outdoorPad: LAYOUT.outdoorPad,
    rooms: ROOMS,
    devices: DEV.map(d => ({ id: d.id, type: d.type, room: d.room, name: d.name, position: d.p, rotationY: d.rotationY ?? 0, ...((d as any).fixture ? { fixture: (d as any).fixture } : {}) })),
    furniture: rt.furniture,
    notes: rt.notes,
    title: rt.title,
    empty: rt.floor === 'none',
    known: rt.floor === 'preset' ? PRESET : null,
    plan: rt.plan ? { url: `/api/building/plan?v=${LAYOUT.version}`, x0: rt.plan.x0, x1: rt.plan.x1, z0: rt.plan.z0, z1: rt.plan.z1 } : null,
  };
}

export function setBuilding(rooms: any[], devices: any[], outdoorPad: any, plan: { dataUrl: string; x0: number; x1: number; z0: number; z1: number } | null, furniture: Runtime['furniture'] = [], notes: Note[] = [], title = 'Uploaded floor plan') {
  rt.planGen = (rt.planGen ?? 0) + 1;
  rt.furniture = furniture;
  rt.title = title;
  rt.notes = notes;
  const pad = outdoorPad ?? (() => { const o = devices.find(d => d.type === 'odu'); return o ? { x: o.position[0], z: o.position[2] } : LAYOUT.outdoorPad; })();
  setLayout(rooms, devices, { outdoorPad: pad, custom: true });
  if (!scenarioAvailable(engineState.scen)) engineState.scen = 'normal';
  if (plan) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(plan.dataUrl);
    if (!m) throw new Error('plan.dataUrl must be a base64 PNG, JPEG or WebP data URL');
    rt.plan = { bytes: Buffer.from(m[2], 'base64'), mime: m[1], x0: plan.x0, x1: plan.x1, z0: plan.z0, z1: plan.z1 };
  } else rt.plan = null;
  rt.overrides = {};
  engineState.fixT = null;
  resetJournal();
  journal({ kind: 'floor', text: `Floor plan "${title}" loaded: ${rooms.length} rooms, ${devices.length} devices, ${furniture.length} furniture items${plan ? ', from an uploaded image' : ''}` });
  return buildingState();
}

/**
 * Default floor: the traced 4th floor (lib/presets, in the repo: rooms, labels, doors, interiors, no devices).
 * If the private drawing is installed in public/presets, it is laid under the floor as the plan image.
 */
const PRESET = 'samsung-rnd-4f';
export function defaultPreset() {
  const priv = path.join(process.cwd(), 'public', 'presets', `${PRESET}.json`);
  const pub = path.join(process.cwd(), 'lib', 'presets', `${PRESET}.json`);
  const file = existsSync(priv) ? priv : existsSync(pub) ? pub : null;
  if (!file) return null;
  const pre = JSON.parse(readFileSync(file, 'utf8'));
  sheet4F(pre.rooms, pre.furniture ?? (pre.furniture = []));   // rooms and doors as the sheet draws them
  const img = pre.image ? path.join(process.cwd(), 'public', pre.image) : null;
  const imgData = img && existsSync(img) ? readFileSync(img) : null;
  const taken = new Set<string>();
  const rooms: PlanRoom[] = pre.rooms.map((r: { name: string; pts: Pt[]; label?: string; labelAt?: Pt; zone?: string }, i: number) => { const key = roomKey(r.name, taken); taken.add(key); return { key, name: r.name, pts: r.pts, color: roomColor(i), label: r.label, labelAt: r.labelAt, zone: r.zone }; });
  const size = imgData ? jpegSize(imgData) : null;
  const aspect = size ? size[1] / size[0] : pre.aspect ?? 1400 / 1930;
  const mime = pre.image?.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUrl = imgData ? `data:${mime};base64,${imgData.toString('base64')}` : '';
  return { title: (pre.title as string).replace(/\s*\(.*\)\s*$/, ''), ...toBuilding(rooms, pre.devices ?? [], pre.widthM, aspect, dataUrl, pre.furniture ?? [], pre.notes ?? []) };
}

/** Width and height of a JPEG from its SOF marker (no image library needed). */
function jpegSize(b: Buffer): [number, number] | null {
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

export function resetBuilding() {
  const pre = defaultPreset();
  if (pre) {
    setBuilding(pre.rooms, pre.devices, undefined, pre.plan, pre.furniture, pre.notes, pre.title);
    LAYOUT.custom = false;
    // the SmartThings Experience Zone is a real, already fitted room (lib/sim/stzone.ts)
    if (fitSmartThingsZone({ rt, addDevice, removeDevice })) LAYOUT.version++;
    return { ...buildingState(), custom: false };
  }
  setLayout(building.rooms, sampleDevices, { outdoorPad: building.outdoorPad, custom: false });
  rt.plan = null;
  rt.furniture = [];
  rt.notes = [];
  rt.title = 'Sample home';
  rt.overrides = {};
  return buildingState();
}

/* ---------------- which floor is showing, kept across restarts ---------------- */
// The app starts with no floor and asks for a plan. The floor last built (an upload, or the recognised 4th floor)
// is saved in .data/floor.json and comes back after a restart. Devices placed later are not saved.
const SAVE = path.join(process.cwd(), '.data', 'floor.json');
function save(x: object | null) {
  try {
    if (!x) { rmSync(SAVE, { force: true }); return; }
    mkdirSync(path.dirname(SAVE), { recursive: true });
    writeFileSync(SAVE, JSON.stringify(x));
  } catch (e) { console.warn('floor not saved:', (e as Error).message); }
}

/** Build an uploaded plan (the body of POST /api/building). */
export function uploadBuilding(b: { rooms: any[]; devices: any[]; outdoorPad?: any; plan?: any; furniture?: any[]; notes?: Note[]; title?: string }, keep = true) {
  const st = setBuilding(b.rooms, b.devices, b.outdoorPad, b.plan ?? null, b.furniture ?? [], b.notes ?? [], b.title);
  rt.floor = 'upload';
  if (keep) save({ upload: b });
  return { ...st, empty: false, known: null };
}

/** A floor the platform has a checked model of (recognised on upload): built from that model. */
export function loadKnownFloor(id: string, keep = true) {
  if (id !== PRESET || !defaultPreset()) throw new Error(`unknown floor ${id}`);
  resetBuilding();
  rt.floor = 'preset';
  if (keep) save({ preset: id });
  return buildingState();
}

/** Forget the floor: the app asks for a plan again. */
export function clearFloor() {
  resetBuilding();
  rt.floor = 'none';
  save(null);
  return buildingState();
}

/** The checked model of a recognised floor as the plan editor shows it (image fractions, like a read plan). */
export function knownFloorPlan(id: string) {
  if (id !== PRESET) return null;
  const priv = path.join(process.cwd(), 'public', 'presets', `${PRESET}.json`);
  const pub = path.join(process.cwd(), 'lib', 'presets', `${PRESET}.json`);
  const file = existsSync(priv) ? priv : existsSync(pub) ? pub : null;
  if (!file) return null;
  const pre = JSON.parse(readFileSync(file, 'utf8'));
  sheet4F(pre.rooms, pre.furniture ?? (pre.furniture = []));   // rooms and doors as the sheet draws them
  const img = pre.image ? path.join(process.cwd(), 'public', pre.image) : null;
  const image = img && existsSync(img) ? `data:image/jpeg;base64,${readFileSync(img).toString('base64')}` : null;
  const [location, floorName] = String(pre.title).replace(/\s*\(.*\)\s*$/, '').split(/\s*·\s*/);
  return {
    known: id, location, floor: floorName ?? '', widthM: pre.widthM, aspect: pre.aspect ?? null, image,
    rooms: pre.rooms.map((r: any) => ({ name: r.name, points: r.pts, ...(r.label ? { label: r.label } : {}), ...(r.zone ? { zone: r.zone } : {}) })),
    doors: (pre.furniture ?? []).filter((f: any) => f.kind === 'door'),
    furniture: (pre.furniture ?? []).filter((f: any) => f.kind !== 'door'),
  };
}

// Start (once per server process): the saved floor, or none yet (the reference floor is loaded underneath so every
// API keeps working, but the pages ask for a plan).
if (!(globalThis as { __twinBooted?: boolean }).__twinBooted) {
  (globalThis as { __twinBooted?: boolean }).__twinBooted = true;
  try { if (defaultPreset()) resetBuilding(); } catch (e) { console.warn('default floor not loaded:', (e as Error).message); }
  try {
    const saved = existsSync(SAVE) ? JSON.parse(readFileSync(SAVE, 'utf8')) : null;
    if (saved?.preset) loadKnownFloor(saved.preset, false);
    else if (saved?.upload) uploadBuilding(saved.upload, false);
  } catch (e) { console.warn('saved floor not loaded:', (e as Error).message); }
}
