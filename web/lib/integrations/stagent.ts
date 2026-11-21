// The SmartThings agent (smartthings-agent/, an LLM agent that speaks SmartThings) integrated with the twin.
//
// The agent is built to call the SmartThings REST API: POST {base}/{deviceId}/commands, GET {base}/{deviceId}/status
// and /health. Its base URL points at the twin's SmartThings-compatible API instead (app/api/st/v1/devices), so
// everything it does goes through the twin like any other command: the 3D room changes at once, the zone's rules
// apply (the Blinds Switch is switched on before the shade moves), a device linked to a real SmartThings device
// gets the real command (the twin holds the token; the agent never sees it), the rest run on the simulator, and a
// guest's assistant can only reach the guest's own room, with the pass's permissions.
//
// Each chat turn opens a short-lived session: its random token is what the agent sends as "Authorization: Bearer"
// to the twin's API, and it carries the scope (host, or one guest pass).
import { randomBytes } from 'node:crypto';
import { DEV, ROOMS, byId } from '@/lib/sim/engine';
import { COMMANDS, device } from '@/lib/sim/runtime';
import { GUEST_HIDDEN } from '@/lib/sim/stzone';
import { guestCommands, guestCommand, type GuestPass } from '@/lib/sim/guests';
import { dispatch } from '@/lib/sim/dispatch';
import * as ST from './smartthings';

export const ST_AGENT_URL = () => (process.env.ST_AGENT_URL ?? 'http://localhost:8100').replace(/\/$/, '');

/* ---------------- sessions ---------------- */

export type Scope = { kind: 'host'; room?: string } | { kind: 'guest'; pass: GuestPass };
type Session = { scope: Scope; until: number };
const g = globalThis as unknown as { __stAgentSessions?: Map<string, Session> };
const sessions: Map<string, Session> = (g.__stAgentSessions ??= new Map());

/** A token for one chat turn (valid 3 minutes: a turn reads status and sends commands within seconds). */
export function openSession(scope: Scope): string {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.until < now) sessions.delete(k);
  const token = randomBytes(24).toString('hex');
  sessions.set(token, { scope, until: now + 180_000 });
  return token;
}

export function sessionFor(authorization: string | null): Scope | null {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const s = token ? sessions.get(token) : undefined;
  if (!s || s.until < Date.now()) return null;
  return s.scope;
}

/* ---------------- devices the agent may see ---------------- */

const nameOf = (d: any) => String(d.name).split(' · ')[0];
const roomName = (key: string) => (ROOMS as any[]).find(r => r.key === key)?.name ?? key;

/** The twin devices in scope: the guest's room, or (host) one room / the SmartThings Experience Zone by default. */
export function devicesInScope(scope: Scope) {
  const room = scope.kind === 'guest' ? scope.pass.room : scope.room ?? 'smartthings-experience-zone';
  return (DEV as any[]).filter(d => d.room === room && !GUEST_HIDDEN.includes(d.type) && COMMANDS[d.type]);
}

/** A device id the agent sent: the twin's id, or the real SmartThings deviceId of a linked device. */
export function resolveDevice(id: string, scope: Scope) {
  const local = byId[id] ? id : ST.links().find(l => l.stId === id)?.localId;
  if (!local) return null;
  return devicesInScope(scope).some(d => d.id === local) ? (byId[local] as any) : null;
}

/** The twin commands the agent may run on a device in this scope (no confirmation-only commands: an agent
 *  cannot unlock a door or stop a wash; those stay in the panel, or the guest page with the PIN). */
function allowedCommands(d: any, scope: Scope): string[] {
  const all = Object.entries(COMMANDS[d.type] ?? {}).filter(([, c]) => !c.confirm).map(([name, c]) => ({ name, args: (c.args ?? {}) as Record<string, any> }));
  const list = scope.kind === 'guest' ? guestCommands(d.type, scope.pass, d.id, true).filter(c => !(c as any).confirm) : ST.supported(d.id, d.type, all);
  return list.map(c => c.name);
}

type StCmd = { component: string; capability: string; command: string; arguments: unknown[] };
const cmd = (capability: string, command: string, args: unknown[] = []): { commands: StCmd[] } => ({ commands: [{ component: 'main', capability, command, arguments: args }] });
const range = (lo: number, hi: number) => `Enter a number in range ${lo} to ${hi}`;
const AC_FAN = ['auto', 'low', 'medium', 'high'];
const PURIFIER_FAN = ['sleep', 'low', 'medium', 'high', 'auto'];
const INPUT: Record<string, string> = { TV: 'digitalTv', 'HDMI 1': 'HDMI1', 'HDMI 2': 'HDMI2', Apps: 'apps' };

/** SmartThings command templates (the agent's "actions" format) for one twin command of a device. */
function actionsFor(d: any, name: string, scope: Scope): { commands: StCmd[] }[] {
  const spec: any = COMMANDS[d.type]?.[name];
  const rule = (k: string) => (scope.kind === 'guest' && name === 'setTemperature' ? scope.pass.acRange : spec?.args?.[k]);
  switch (`${d.type}.${name}`) {
    case 'light.power': case 'tv.power': case 'ac.power': case 'plug.power': case 'purifier.power': case 'fan.power':
      return [cmd('switch', 'on'), cmd('switch', 'off')];
    case 'light.setLevel': return [cmd('switchLevel', 'setLevel', [range(1, 100)])];
    case 'light.setColorTemperature': { const [lo, hi] = rule('kelvin'); return [cmd('colorTemperature', 'setColorTemperature', [range(lo, hi)])]; }
    case 'light.setHueSat': return [cmd('colorControl', 'setColor', [{ hue: 'Enter hue', saturation: 'Enter saturation' }])];
    case 'blinds.open': return [cmd('windowShade', 'open')];
    case 'blinds.close': return [cmd('windowShade', 'close')];
    case 'blinds.setPosition': return [cmd('windowShadeLevel', 'setShadeLevel', [range(0, 100)])];
    case 'ac.setTemperature': { const [lo, hi] = rule('celsius'); return [cmd('thermostatCoolingSetpoint', 'setCoolingSetpoint', [range(lo, hi)])]; }
    case 'ac.setMode': return (spec.args.mode as string[]).map(m => cmd('airConditionerMode', 'setAirConditionerMode', [m === 'fan' ? 'fanOnly' : m]));
    case 'ac.setFanSpeed': return AC_FAN.map(m => cmd('airConditionerFanMode', 'setFanMode', [m]));
    case 'tv.setVolume': return [cmd('audioVolume', 'setVolume', [range(0, 100)])];
    case 'tv.setInput': return (spec.args.source as string[]).map(s => cmd('mediaInputSource', 'setInputSource', [INPUT[s] ?? s]));
    case 'purifier.setFan': return PURIFIER_FAN.map(m => cmd('airPurifierFanMode', 'setAirPurifierFanMode', [m]));
    case 'fan.setSpeed': return [cmd('fanSpeed', 'setFanSpeed', [range(1, 3)])];
    case 'lock.lock': return [cmd('lock', 'lock')];
    case 'vacuum.start': return [cmd('robotCleanerMovement', 'setRobotCleanerMovement', ['cleaning'])];
    case 'vacuum.dock': return [cmd('robotCleanerMovement', 'setRobotCleanerMovement', ['homing'])];
  }
  return [];
}

/** The agent's `devices` (id, name, room, actions) and `rooms_context` for a scope. Device names are the twin's
 *  names, which are the real SmartThings labels in the zone. */
export function agentContext(scope: Scope) {
  const devs = devicesInScope(scope);
  const devices = devs.map(d => ({
    id: d.id, name: nameOf(d), room: roomName(d.room),
    actions: allowedCommands(d, scope).flatMap(n => actionsFor(d, n, scope)),
  })).filter(d => d.actions.length || ['temphum', 'motion', 'leak', 'camera'].includes(byId[d.id].type));
  const rooms = [...new Set(devs.map(d => d.room))].map(k => ({ id: k, name: roomName(k), devices: devices.filter(x => byId[x.id].room === k).map(x => x.name) }));
  return { devices, rooms_context: { rooms } };
}

/* ---------------- SmartThings commands -> twin commands ---------------- */

/** The twin command for one SmartThings command on a device, or an error. */
export function toTwin(d: any, c: StCmd): { name: string; args: Record<string, unknown> } | { error: string } {
  const a = Array.isArray(c.arguments) ? c.arguments : [];
  const n = Number(a[0]);
  switch (`${c.capability}.${c.command}`) {
    case 'switch.on': case 'switch.off': return { name: 'power', args: { on: c.command === 'on' ? 'true' : 'false' } };
    case 'switchLevel.setLevel': return { name: 'setLevel', args: { percent: n } };
    case 'colorTemperature.setColorTemperature': return { name: 'setColorTemperature', args: { kelvin: n } };
    case 'colorControl.setColor': { const v: any = a[0] ?? {}; return { name: 'setHueSat', args: { hue: Number(v.hue), saturation: Number(v.saturation) } }; }
    case 'windowShade.open': return { name: 'open', args: {} };
    case 'windowShade.close': return { name: 'close', args: {} };
    case 'windowShadeLevel.setShadeLevel': return { name: 'setPosition', args: { percent: n } };
    case 'thermostatCoolingSetpoint.setCoolingSetpoint': return { name: 'setTemperature', args: { celsius: n } };
    case 'airConditionerMode.setAirConditionerMode': return { name: 'setMode', args: { mode: a[0] === 'fanOnly' ? 'fan' : String(a[0]) } };
    case 'airConditionerFanMode.setFanMode': return { name: 'setFanSpeed', args: { percent: { auto: 0, low: 30, medium: 60, high: 90 }[String(a[0])] ?? 60 } };
    case 'audioVolume.setVolume': return { name: 'setVolume', args: { percent: n } };
    case 'mediaInputSource.setInputSource': return { name: 'setInput', args: { source: Object.entries(INPUT).find(([, v]) => v === a[0])?.[0] ?? String(a[0]) } };
    case 'airPurifierFanMode.setAirPurifierFanMode': return { name: 'setFan', args: { level: Math.max(1, PURIFIER_FAN.indexOf(String(a[0])) + 1) } };
    case 'fanSpeed.setFanSpeed': return { name: 'setSpeed', args: { level: n } };
    case 'lock.lock': return { name: 'lock', args: {} };
    case 'robotCleanerMovement.setRobotCleanerMovement': return { name: a[0] === 'cleaning' ? 'start' : 'dock', args: {} };
  }
  return { error: `${nameOf(d)} has no command ${c.capability}.${c.command}` };
}

/** Run a SmartThings command body on a twin device, in scope. All commands run in order; the first failure stops. */
export async function runCommands(d: any, commands: StCmd[], scope: Scope) {
  const allowed = new Set(allowedCommands(d, scope));
  const done: string[] = [];
  for (const c of commands) {
    const t = toTwin(d, c);
    if ('error' in t) return { ok: false as const, status: 422, error: t.error };
    if (!allowed.has(t.name)) return { ok: false as const, status: 403, error: `${nameOf(d)} can't do "${c.capability}.${c.command}" here` };
    // a bulb set on again keeps its level (SmartThings "on"); "off" from a level of 0 is the same as power off
    const by = scope.kind === 'guest' ? undefined : 'smartthings agent';
    const r = scope.kind === 'guest'
      ? await guestCommand(scope.pass, d.id, t.name, t.args)
      : await dispatch(d.id, t.name, t.args, false, by);
    const ok = 'body' in r ? r.status === 200 : r.ok;
    if (!ok) {
      const err = 'body' in r ? String((r.body as any).error ?? 'refused') : r.error ?? 'refused';
      const offline = 'body' in r ? !!(r.body as any).offline : !!r.offline;
      return { ok: false as const, status: offline ? 409 : 422, error: err };
    }
    done.push(t.name);
  }
  return { ok: true as const, done };
}

/* ---------------- twin state -> SmartThings status ---------------- */

const at = (value: unknown, unit?: string) => ({ value, ...(unit ? { unit } : {}), timestamp: new Date().toISOString() });
function hexToHueSat(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dd = mx - mn;
  let h = 0; if (dd) h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return { hue: Math.round(((h * 60 + 360) % 360) / 3.6), saturation: Math.round((mx ? dd / mx : 0) * 100) };
}

/** The device's state as a SmartThings status document (what GET /devices/{id}/status returns). The twin's
 *  readings are the real device's reported state when it is linked, else the simulator's. */
export function statusDoc(d: any) {
  const s: any = device(d.id);
  const r: Record<string, any> = s?.readings ?? {};
  const m: Record<string, any> = {};
  const caps = new Set(ST.link(d.id)?.capabilities ?? []);
  const has = (c: string) => !caps.size || caps.has(c);
  switch (d.type) {
    case 'light': {
      const lv = Number(r.lv ?? 0);
      m.switch = { switch: at(lv > 0 ? 'on' : 'off') };
      if (has('switchLevel')) m.switchLevel = { level: at(lv > 0 ? lv : Number(r.lastLv ?? 100), '%') };
      if (has('colorTemperature') && r.ct != null) m.colorTemperature = { colorTemperature: at(Number(r.ct), 'K') };
      if (has('colorControl')) { const hs = /^#[0-9a-f]{6}$/i.test(String(r.col ?? '')) ? hexToHueSat(String(r.col)) : { hue: 0, saturation: 0 }; m.colorControl = { hue: at(hs.hue), saturation: at(hs.saturation) }; }
      break;
    }
    case 'blinds': { const pos = Number(r.pos ?? 100); m.windowShade = { windowShade: at(pos >= 99 ? 'open' : pos <= 1 ? 'closed' : 'partially open') }; m.windowShadeLevel = { shadeLevel: at(pos, '%') }; break; }
    case 'plug': m.switch = { switch: at(r.on === false ? 'off' : 'on') }; break;
    case 'tv': m.switch = { switch: at(r.on === false ? 'off' : 'on') }; if (r.vol != null) m.audioVolume = { volume: at(Number(r.vol), '%') }; if (r.input) m.mediaInputSource = { inputSource: at(INPUT[String(r.input)] ?? r.input) }; break;
    case 'ac':
      m.switch = { switch: at(r.on === false ? 'off' : 'on') };
      if (r.set != null) m.thermostatCoolingSetpoint = { coolingSetpoint: at(Number(r.set), 'C') };
      if (r.room != null) m.temperatureMeasurement = { temperature: at(Math.round(Number(r.room) * 10) / 10, 'C') };
      if (r.mode) m.airConditionerMode = { airConditionerMode: at(r.mode === 'fan' ? 'fanOnly' : r.mode) };
      break;
    case 'purifier': m.switch = { switch: at(r.on === false ? 'off' : 'on') }; if (r.fan != null) m.airPurifierFanMode = { airPurifierFanMode: at(PURIFIER_FAN[Math.max(0, Math.min(4, Number(r.fan) - 1))]) }; break;
    case 'fan': m.switch = { switch: at(r.on === false ? 'off' : 'on') }; if (r.speed != null) m.fanSpeed = { fanSpeed: at(Number(r.speed)) }; break;
    case 'lock': m.lock = { lock: at(r.locked === false ? 'unlocked' : 'locked') }; if (r.batt != null) m.battery = { battery: at(Number(r.batt), '%') }; break;
    case 'temphum': if (r.temp != null) m.temperatureMeasurement = { temperature: at(Number(r.temp), 'C') }; if (r.hum != null) m.relativeHumidityMeasurement = { humidity: at(Number(r.hum), '%') }; break;
    case 'vacuum': m.robotCleanerMovement = { robotCleanerMovement: at(r.state === 'Cleaning' ? 'cleaning' : 'homing') }; break;
  }
  return { components: { main: m }, online: s ? s.online !== false : false };
}

/* ---------------- one chat turn: the PoC's chat events from the agent's stream ---------------- */

export type Turn = { messages: { role: string; content: string }[] };
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Run one turn of the SmartThings agent (POST {ST_AGENT_URL}/control/stream) and answer with the PoC's chat
 * events (docs/contracts/agent-api.md): `tool` for each progress step, `text` for the reply, `ui_action` to show
 * the devices it changed or read in 3D, `result` (guest page) with each device's outcome, `error`, then `done`.
 */
export function agentTurn(turn: Turn, scope: Scope, opts: { guest?: boolean } = {}): Response {
  const msgs = (turn.messages ?? []).filter(m => m && typeof m.content === 'string' && m.content.trim());
  const last = [...msgs].reverse().find(m => m.role === 'user');
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const out = (event: string, data: unknown) => controller.enqueue(enc.encode(sse(event, data)));
      try {
        if (!last) { out('error', { message: 'Nothing to answer.' }); return; }
        const { devices, rooms_context } = agentContext(scope);
        const session = openSession(scope);
        let up: Response;
        try {
          up = await fetch(`${ST_AGENT_URL()}/control/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${session}` },
            body: JSON.stringify({ message: last.content, messages: msgs.map(m => ({ role: m.role, text: m.content })), devices, extras: { rooms_context } }),
            signal: AbortSignal.timeout(120_000),
          });
        } catch {
          out('error', { message: `The SmartThings agent is not reachable at ${ST_AGENT_URL()}. Start smartthings-agent (see its README).` });
          return;
        }
        if (!up.ok || !up.body) { out('error', { message: `The SmartThings agent answered HTTP ${up.status}.` }); return; }
        const reader = up.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1]?.trim();
            let data: any = {};
            try { data = JSON.parse(/^data: (.*)$/ms.exec(block)?.[1] ?? '{}'); } catch { /* ignore a broken line */ }
            if (ev === 'status') { if (!opts.guest) out('tool', { name: 'SmartThings agent', summary: String(data.text ?? data.stage ?? '') }); }
            else if (ev === 'error') out('error', { message: String(data.detail ?? 'The SmartThings agent failed.') });
            else if (ev === 'final') {
              const text = String(data?.data?.question ?? data?.message ?? '');
              if (text) out('text', { text });
              const results: any[] = data?.data?.results ?? [];
              const states: any[] = data?.data?.states ?? [];
              const ids = [...new Set([...results, ...states].map(r => String(r.device_id ?? '')).map(id => resolveDevice(id, scope)?.id).filter(Boolean))] as string[];
              if (ids.length) {
                out('ui_action', { type: 'highlight', ids, reason: results.length ? 'changed by the SmartThings agent' : 'asked about' });
                // the 3D view turns to a single device; the chat stays open (no `select`: that would replace it)
                if (ids.length === 1) out('ui_action', { type: 'focusDevice', id: ids[0] });
              }
              if (opts.guest && results.length) out('result', { results: results.map(r => {
                const d = resolveDevice(String(r.device_id), scope);
                return { device_id: d?.id ?? r.device_id, label: r.device_name, type: d?.type ?? '', command: '', args: {}, summary: 'done', ok: r.status === 'success', error: r.status === 'success' ? undefined : String(r.api_result?.response?.error?.message ?? r.api_result?.error ?? 'did not respond') };
              }) });
            }
          }
        }
      } catch (e) {
        out('error', { message: `SmartThings agent: ${(e as Error).message}` });
      } finally {
        out('done', {});
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

/** Whether the SmartThings agent is up (GET {ST_AGENT_URL}/health). */
export async function agentHealth() {
  try {
    const r = await fetch(`${ST_AGENT_URL()}/health`, { signal: AbortSignal.timeout(2500) });
    const d = await r.json();
    return { ok: r.ok, url: ST_AGENT_URL(), model: d?.model ?? null, skills: d?.skills ?? [] };
  } catch { return { ok: false, url: ST_AGENT_URL(), model: null, skills: [] }; }
}
