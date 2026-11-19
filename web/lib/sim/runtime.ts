// Runtime state of the simulated device platform: scenario, clock and device overrides.
// Kept on globalThis so it survives hot reloads in development. One process = one demo.
import { DEV, SCEN, TYPES, ROOMS, byId, snapshot, state as engineState, health, LBL, LAYOUT, setLayout, scenarioName, scenarioAvailable } from './engine';
import building from './data/building.json';
import sampleDevices from './data/devices.json';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { roomColor, roomKey, toBuilding, type PlanRoom, type Pt } from '@/lib/layout';

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
}
const g = globalThis as unknown as { __twin?: Runtime };
export const rt: Runtime = (g.__twin ??= { t: 10, playing: false, speed: 0.5, lastTick: Date.now(), overrides: {}, log: [], plan: null, furniture: [] });
rt.furniture ??= [];

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
  rt.lastTick = Date.now();
  return simState();
}

/** Device snapshot with command overrides applied on top of simulated readings. */
export function device(id: string, t = tick()) {
  const o = rt.overrides[id] ?? null;
  const s = snapshot(id, t, o);
  if (!s) return null;
  return { ...s, overrides: o };
}

/** Readings the floor view needs for every refrigerant circuit, sent with each /api/floor poll. */
const LIVE: Record<string, string[]> = { ac: ['on', 'fan', 'air', 'evIn', 'evOut', 'sh', 'room', 'set'], odu: ['hz', 'dis', 'suc', 'lp', 'hp', 'fan'] };
function live(id: string, t: number) {
  const d = device(id, t)!;
  return Object.fromEntries(LIVE[d.type].map(k => [k, (d.readings as Record<string, unknown>)[k]]));
}

export function floor(t = tick()) {
  return {
    time: t,
    scenario: engineState.scen,
    layoutVersion: LAYOUT.version,
    rooms: ROOMS,
    devices: DEV.map(d => { const h = health(d, t); return { id: d.id, type: d.type, label: TYPES[d.type].label, room: d.room, name: d.name, position: d.p, rotationY: d.rotationY, health: h, healthLabel: LBL[h], ...(LIVE[d.type] ? { live: live(d.id, t) } : {}) }; }),
  };
}

/* ---------------- device commands ---------------- */
// Whitelisted commands per device type. `confirm` commands must be confirmed by the user first
// (the agent asks; the API rejects them unless confirmed=true).
export const COMMANDS: Record<string, Record<string, { args?: Record<string, [number, number] | string[]>; confirm?: boolean; apply: (a: any) => Override }>> = {
  ac: {
    power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) },
    setTemperature: { args: { celsius: [16, 30] }, apply: a => ({ set: +a.celsius }) },
    setFanSpeed: { args: { percent: [0, 100] }, apply: a => ({ fan: +a.percent }) },
  },
  light: { setLevel: { args: { percent: [0, 100] }, apply: a => ({ lv: +a.percent }) } },
  blinds: { setPosition: { args: { percent: [0, 100] }, apply: a => ({ pos: +a.percent }) } },
  plug: { power: { args: { on: ['true', 'false'] }, apply: a => ({ on: a.on === true || a.on === 'true' }) } },
  lock: {
    lock: { apply: () => ({ locked: true }) },
    unlock: { confirm: true, apply: () => ({ locked: false }) },
  },
  washer: { stop: { confirm: true, apply: () => ({ state: 'Stopped by user' }) } },
  purifier: { setFan: { args: { level: [1, 5] }, apply: a => ({ fan: +a.level }) } },
  vacuum: { start: { apply: () => ({ state: 'Cleaning' }) }, dock: { apply: () => ({ state: 'Docked' }) } },
};

export function runCommand(id: string, command: string, args: Record<string, unknown> = {}, confirmed = false, by = 'user') {
  const d = byId[id];
  if (!d) return { ok: false, error: `Unknown device ${id}` };
  const spec = COMMANDS[d.type]?.[command];
  if (!spec) return { ok: false, error: `${TYPES[d.type].label} does not support "${command}". Supported: ${Object.keys(COMMANDS[d.type] ?? {}).join(', ') || 'none'}` };
  if (spec.confirm && !confirmed) return { ok: false, needsConfirmation: true, error: `"${command}" on ${id} needs explicit confirmation` };
  for (const [k, rule] of Object.entries(spec.args ?? {})) {
    const v = args[k];
    if (v === undefined) return { ok: false, error: `Missing argument "${k}"` };
    if (Array.isArray(rule) && typeof rule[0] === 'number') { const n = Number(v); if (Number.isNaN(n) || n < (rule[0] as number) || n > (rule[1] as number)) return { ok: false, error: `"${k}" must be between ${rule[0]} and ${rule[1]}` }; }
    else if (Array.isArray(rule) && !rule.map(String).includes(String(v))) return { ok: false, error: `"${k}" must be one of ${rule.join(', ')}` };
  }
  rt.overrides[id] = { ...(rt.overrides[id] ?? {}), ...spec.apply(args) };
  rt.log.push({ at: rt.t, deviceId: id, command, args, by });
  return { ok: true, device: device(id) };
}

/* ---------------- building layout (floor plan upload) ---------------- */

/** Static layout for the renderer: rooms, device placements and the plan image bounds. */
export function buildingState() {
  return {
    version: LAYOUT.version,
    custom: LAYOUT.custom,
    wallHeight: LAYOUT.wallHeight,
    outdoorPad: LAYOUT.outdoorPad,
    rooms: ROOMS,
    devices: DEV.map(d => ({ id: d.id, type: d.type, room: d.room, name: d.name, position: d.p, rotationY: d.rotationY ?? 0 })),
    furniture: rt.furniture,
    plan: rt.plan ? { url: `/api/building/plan?v=${LAYOUT.version}`, x0: rt.plan.x0, x1: rt.plan.x1, z0: rt.plan.z0, z1: rt.plan.z1 } : null,
  };
}

export function setBuilding(rooms: any[], devices: any[], outdoorPad: any, plan: { dataUrl: string; x0: number; x1: number; z0: number; z1: number } | null, furniture: Runtime['furniture'] = []) {
  rt.furniture = furniture;
  const pad = outdoorPad ?? (() => { const o = devices.find(d => d.type === 'odu'); return o ? { x: o.position[0], z: o.position[2] } : LAYOUT.outdoorPad; })();
  setLayout(rooms, devices, { outdoorPad: pad, custom: true });
  if (!scenarioAvailable(engineState.scen)) engineState.scen = 'normal';
  if (plan) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(plan.dataUrl);
    if (!m) throw new Error('plan.dataUrl must be a base64 PNG, JPEG or WebP data URL');
    rt.plan = { bytes: Buffer.from(m[2], 'base64'), mime: m[1], x0: plan.x0, x1: plan.x1, z0: plan.z0, z1: plan.z1 };
  }
  rt.overrides = {};
  engineState.fixT = null;
  return buildingState();
}

/**
 * Default floor. If a preset is installed in public/presets (the private reference floor), the platform starts with it,
 * so the map shows a real floor without an upload; otherwise it uses the small built-in sample home.
 */
const PRESET = 'samsung-rnd-4f';
export function defaultPreset() {
  const dir = path.join(process.cwd(), 'public', 'presets');
  const json = path.join(dir, `${PRESET}.json`);
  if (!existsSync(json)) return null;
  const pre = JSON.parse(readFileSync(json, 'utf8'));
  const img = path.join(process.cwd(), 'public', pre.image);
  if (!existsSync(img)) return null;
  const taken = new Set<string>();
  const rooms: PlanRoom[] = pre.rooms.map((r: { name: string; pts: Pt[] }, i: number) => { const key = roomKey(r.name, taken); taken.add(key); return { key, name: r.name, pts: r.pts, color: roomColor(i) }; });
  const size = jpegSize(readFileSync(img));
  const mime = pre.image.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return toBuilding(rooms, pre.devices, pre.widthM, size ? size[1] / size[0] : 1400 / 1930, `data:${mime};base64,${readFileSync(img).toString('base64')}`, pre.furniture ?? []);
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
    const out = setBuilding(pre.rooms, pre.devices, undefined, pre.plan, pre.furniture);
    LAYOUT.custom = false;
    return { ...out, custom: false };
  }
  setLayout(building.rooms, sampleDevices, { outdoorPad: building.outdoorPad, custom: false });
  rt.plan = null;
  rt.furniture = [];
  rt.overrides = {};
  return buildingState();
}

// Start on the default floor (once per server process).
if (!(globalThis as { __twinBooted?: boolean }).__twinBooted) {
  (globalThis as { __twinBooted?: boolean }).__twinBooted = true;
  try { if (defaultPreset()) resetBuilding(); } catch (e) { console.warn('default floor not loaded:', (e as Error).message); }
}
