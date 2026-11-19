// Runtime state of the simulated device platform: scenario, clock and device overrides.
// Kept on globalThis so it survives hot reloads in development. One process = one demo.
import { DEV, SCEN, TYPES, ROOMS, byId, snapshot, state as engineState, health, LBL } from './engine';

type Override = Record<string, unknown>;
interface Runtime {
  t: number; // scene time in hours (6..22)
  playing: boolean;
  speed: number; // simulated hours per real second
  lastTick: number; // ms
  overrides: Record<string, Override>; // per-device values set by commands
  log: { at: number; deviceId: string; command: string; args: unknown; by: string }[];
}
const g = globalThis as unknown as { __twin?: Runtime };
export const rt: Runtime = (g.__twin ??= { t: 10, playing: false, speed: 0.5, lastTick: Date.now(), overrides: {}, log: [] });

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
  return { t: +rt.t.toFixed(3), playing: rt.playing, speed: rt.speed, scenario: engineState.scen, fixT: engineState.fixT, scenarios: Object.entries(SCEN).map(([key, s]) => ({ key, name: (s as { name: string }).name })) };
}

export function setSim(p: { scenario?: string; t?: number; playing?: boolean; speed?: number; fix?: boolean }) {
  if (p.scenario && p.scenario in SCEN) { engineState.scen = p.scenario; engineState.fixT = null; rt.overrides = {}; }
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

export function floor(t = tick()) {
  return {
    time: t,
    scenario: engineState.scen,
    rooms: ROOMS,
    devices: DEV.map(d => { const h = health(d, t); return { id: d.id, type: d.type, label: TYPES[d.type].label, room: d.room, name: d.name, position: d.p, rotationY: d.rotationY, health: h, healthLabel: LBL[h] }; }),
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
