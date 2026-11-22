// SmartThings connector: a device on the twin can be linked to a real SmartThings device. Commands to a linked
// device go to the SmartThings REST API (POST /v1/devices/{id}/commands, Bearer personal access token or OAuth
// token); its real status (GET /v1/devices/{id}/status) replaces the simulated readings it covers.
// Unlinked devices keep using the simulator, so a floor can mix real and simulated devices.
//
// Configure with SMARTTHINGS_TOKEN (and SMARTTHINGS_API for a different base URL, e.g. a test double), or enter a
// token on /integrations (kept in memory only).

import { log as journal } from '@/lib/kg/journal';

export type Link = { localId: string; stId: string; component: string; label?: string; type: string; capabilities?: string[]; acModes?: string[] };
type StCommand = { component: string; capability: string; command: string; arguments: unknown[] };

type Status = { at: number; readings: Record<string, unknown>; online: boolean; healthAt?: number };
/** Values a command just set, shown over the device's last report until it reports them (or the hold runs out),
 *  so the twin never flicks back to the old state while the real device is still moving. */
type Hold = { keys: string[]; before: Record<string, unknown>; until: number;
  /** A moving device (a shade): what it was told to reach. The hold stays until it gets there (it reports the
   *  positions on the way, which must not show as the end state), or runs out. */
  target?: Record<string, number>; cmds?: StCommand[]; resent?: boolean; sentAt?: number };
type State = {
  token: string; links: Record<string, Link>; status: Record<string, Status>; lastError: string;
  holds: Record<string, Hold>;
  /** Bumped whenever a real device reports a different state or goes on/offline (the event stream watches it). */
  version: number;
  poll: { lastAt: number; lastOk: number; ms: number; batch: boolean | null; backoffUntil: number; running: boolean; errors: number };
};
const g = globalThis as unknown as { __st?: State };
const st: State = (g.__st ??= { token: process.env.SMARTTHINGS_TOKEN ?? '', links: {}, status: {}, lastError: '', holds: {}, version: 0, poll: { lastAt: 0, lastOk: 0, ms: 0, batch: null, backoffUntil: 0, running: false, errors: 0 } });
st.holds ??= {};
st.version ??= 0;
st.poll ??= { lastAt: 0, lastOk: 0, ms: 0, batch: null, backoffUntil: 0, running: false, errors: 0 };
if (!st.token && process.env.SMARTTHINGS_TOKEN) st.token = process.env.SMARTTHINGS_TOKEN;

/** How often linked devices' real status is read (ms). One batched request per round when the API allows it. */
export const POLL_MS = Math.max(1000, Number(process.env.SMARTTHINGS_POLL_MS) || 2000);
const HOLD_MS = 8000;
/** How long a shade may take to roll all the way (a full Aqara roller run is about 30-40 s). */
const MOVE_MS = 60_000;

const base = () => (process.env.SMARTTHINGS_API ?? 'https://api.smartthings.com/v1').replace(/\/$/, '');
export const configured = () => !!st.token;
export function setToken(token: string) { st.token = token.trim(); st.lastError = ''; st.poll.batch = null; st.poll.backoffUntil = 0; }
export const version = () => st.version;
export function links() { return Object.values(st.links); }
export function link(localId: string) { return st.links[localId] ?? null; }
export function setLink(l: Link) { st.links[l.localId] = { ...l, component: l.component || 'main' }; delete st.status[l.localId]; delete st.holds[l.localId]; st.version++; }
export function unlink(localId: string) { delete st.links[localId]; delete st.status[localId]; delete st.holds[localId]; st.version++; }
export function info() {
  const p = st.poll;
  return { configured: configured(), api: base(), links: links(), lastError: st.lastError,
    live: { pollMs: POLL_MS, lastPollAt: p.lastAt || null, lastOkAt: p.lastOk || null, roundMs: p.ms, batched: p.batch, errors: p.errors,
      online: Object.values(st.status).filter(x => x.online).length, offline: Object.values(st.status).filter(x => !x.online).length } };
}

async function call(path: string, init: RequestInit = {}) {
  if (!st.token) throw new Error('SmartThings is not connected (no token)');
  const r = await fetch(`${base()}${path}`, { ...init, headers: { Authorization: `Bearer ${st.token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (r.status === 429) {
    // rate limited: stop polling until SmartThings says it may be asked again
    const wait = Number(r.headers.get('Retry-After')) || Number(r.headers.get('X-RateLimit-Reset')) / 1000 || 10;
    st.poll.backoffUntil = Date.now() + Math.min(120, Math.max(2, wait)) * 1000;
  }
  if (!r.ok) {
    const msg = body?.error?.message ?? body?.message ?? `HTTP ${r.status}`;
    st.lastError = `${path}: ${msg}`;
    throw new Error(`SmartThings: ${msg}`);
  }
  return body;
}

/** The capabilities a SmartThings device has on a component (GET /devices/{id}), to show only the controls it supports. */
export async function describe(stId: string, component = 'main') {
  const d: any = await call(`/devices/${encodeURIComponent(stId)}`);
  const comp = (d.components ?? []).find((c: any) => c.id === component) ?? d.components?.[0];
  return { label: d.label ?? d.name ?? stId, capabilities: (comp?.capabilities ?? []).map((c: any) => c.id) as string[] };
}

/** Devices in the SmartThings account (for linking). */
export async function accountDevices() {
  const out: { stId: string; label: string; capabilities: string[] }[] = [];
  let next: string | null = '/devices';
  while (next && out.length < 500) {
    const page: any = await call(next);
    for (const d of page.items ?? []) out.push({ stId: d.deviceId, label: d.label ?? d.name ?? d.deviceId, capabilities: (d.components ?? []).flatMap((c: any) => (c.capabilities ?? []).map((x: any) => x.id)) });
    const href: string | undefined = page._links?.next?.href;
    next = href ? href.replace(/^https?:\/\/[^/]+\/v1/, '') : null;
  }
  return out;
}

/** Every device in the account with its room id and category (GET /devices, all pages). */
export async function accountDevicesFull() {
  const out: { stId: string; label: string; roomId: string; category: string; capabilities: string[] }[] = [];
  let next: string | null = '/devices';
  while (next && out.length < 500) {
    const page: any = await call(next);
    for (const d of page.items ?? []) {
      const main = (d.components ?? []).find((c: any) => c.id === 'main') ?? d.components?.[0];
      out.push({ stId: d.deviceId, label: d.label ?? d.name ?? d.deviceId, roomId: d.roomId ?? '', category: main?.categories?.[0]?.name ?? '', capabilities: (main?.capabilities ?? []).map((x: any) => x.id) });
    }
    const href: string | undefined = page._links?.next?.href;
    next = href ? href.replace(/^https?:\/\/[^/]+\/v1/, '') : null;
  }
  return out;
}

/** Room names by room id, across the account's locations (GET /locations, /locations/{id}/rooms). */
export async function accountRooms() {
  const names: Record<string, string> = {};
  const locs: any = await call('/locations');
  for (const l of locs.items ?? []) {
    const rooms: any = await call(`/locations/${encodeURIComponent(l.locationId)}/rooms`).catch(() => ({ items: [] }));
    for (const r of rooms.items ?? []) names[r.roomId] = r.name;
  }
  return names;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const AC_FAN = (p: number) => (p <= 0 ? 'auto' : p < 45 ? 'low' : p < 75 ? 'medium' : 'high');

/** The SmartThings command(s) for one of the twin's commands, by device type. Null: no equivalent. */
export function translate(type: string, command: string, a: Record<string, unknown>, component = 'main'): StCommand[] | null {
  const c = (capability: string, cmd: string, args: unknown[] = []): StCommand => ({ component, capability, command: cmd, arguments: args });
  const on = a.on === true || a.on === 'true';
  switch (`${type}.${command}`) {
    case 'lock.lock': return [c('lock', 'lock')];
    case 'lock.unlock': return [c('lock', 'unlock')];
    case 'ac.power': case 'tv.power': case 'fan.power': case 'plug.power': case 'purifier.power': return [c('switch', on ? 'on' : 'off')];
    case 'light.power': return [c('switch', on ? 'on' : 'off')];
    // real bulbs take a level of 1-100 (0 is off) and a colour temperature of 2200-6500 K
    case 'light.setLevel': return Number(a.percent) <= 0 ? [c('switch', 'off')] : [c('switch', 'on'), c('switchLevel', 'setLevel', [clamp(Math.round(Number(a.percent)), 1, 100)])];
    case 'light.setColor': {
      // SmartThings colorControl takes hue and saturation on a 0-100 scale
      const hex = String(({ pink: '#ff6fae', purple: '#8b5cf6', blue: '#3b82f6', cyan: '#22d3ee', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' } as Record<string, string>)[String(a.color)] ?? '#ffffff');
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [c('switch', 'on'), c('colorControl', 'setColor', [{ hue: Math.round(((h * 60 + 360) % 360) / 3.6), saturation: Math.round((mx ? d / mx : 0) * 100) }])];
    }
    case 'light.setHueSat': return [c('switch', 'on'), c('colorControl', 'setColor', [{ hue: clamp(Math.round(Number(a.hue)), 0, 100), saturation: clamp(Math.round(Number(a.saturation)), 0, 100) }])];
    case 'light.setColorTemperature': return [c('switch', 'on'), c('colorTemperature', 'setColorTemperature', [clamp(Math.round(Number(a.kelvin)), 2200, 6500)])];
    case 'ac.setTemperature': return [c('thermostatCoolingSetpoint', 'setCoolingSetpoint', [Number(a.celsius)])];
    case 'ac.setMode': return [c('airConditionerMode', 'setAirConditionerMode', [String(a.mode) === 'fan' ? 'fanOnly' : String(a.mode)])];
    case 'ac.setFanSpeed': return [c('airConditionerFanMode', 'setFanMode', [AC_FAN(Number(a.percent))])];
    case 'ac.setSwing': return [c('fanOscillationMode', 'setFanOscillationMode', [String(a.position) === 'swing' ? 'vertical' : 'fixed'])];
    case 'tv.setVolume': return [c('audioVolume', 'setVolume', [Math.round(Number(a.percent))])];
    case 'tv.setInput': return [c('mediaInputSource', 'setInputSource', [String(a.source).replace(' ', '').replace('TV', 'digitalTv')])];
    case 'fan.setSpeed': return [c('switch', 'on'), c('fanSpeed', 'setFanSpeed', [Number(a.level)])];
    case 'fan.setOscillation': return [c('fanOscillationMode', 'setFanOscillationMode', [on ? 'all' : 'fixed'])];
    case 'blinds.open': return [c('windowShade', 'open')];
    case 'blinds.close': return [c('windowShade', 'close')];
    case 'blinds.setPosition': return [c('windowShadeLevel', 'setShadeLevel', [clamp(Math.round(Number(a.percent)), 0, 100)])];
    case 'purifier.setFan': return [c('switch', 'on'), c('airPurifierFanMode', 'setAirPurifierFanMode', [['sleep', 'low', 'medium', 'high', 'auto'][Math.max(0, Math.min(4, Number(a.level) - 1))]])];
    case 'vacuum.start': return [c('robotCleanerMovement', 'setRobotCleanerMovement', ['cleaning'])];
    case 'vacuum.dock': return [c('robotCleanerMovement', 'setRobotCleanerMovement', ['homing'])];
  }
  return null;
}

/** The twin readings each SmartThings capability drives (what a command on it changes). */
const KEYS: Record<string, string[]> = {
  switch: ['on', 'lv'], switchLevel: ['lv', 'on'], colorTemperature: ['ct', 'col'], colorControl: ['col'],
  windowShade: ['pos'], windowShadeLevel: ['pos'], lock: ['locked'], thermostatCoolingSetpoint: ['set'],
  airConditionerMode: ['mode', 'on'], audioVolume: ['vol'], fanSpeed: ['speed', 'on'],
};

/** Sends a twin command to the linked SmartThings device. */
/** `expect`: the values the twin shows for this command (they are held until the device reports). */
export async function send(localId: string, type: string, command: string, args: Record<string, unknown>, expect?: Record<string, unknown>) {
  const l = st.links[localId];
  if (!l) throw new Error(`${localId} is not linked to SmartThings`);
  const cmds = translate(type, command, args, l.component);
  if (!cmds) throw new Error(`"${command}" has no SmartThings equivalent for this device`);
  const res: any = await call(`/devices/${encodeURIComponent(l.stId)}/commands`, { method: 'POST', body: JSON.stringify({ commands: cmds }) });
  // the API can take the request and still report that the device did not run it
  const failed = (res?.results ?? []).filter((x: any) => /FAILED|REJECTED/i.test(String(x?.status)));
  if (failed.length) {
    refresh(localId).catch(() => {});
    throw new Error(`SmartThings: ${l.label ?? 'the device'} did not run the command (${failed.map((x: any) => x.status).join(', ')}${st.status[localId]?.online === false ? ', device offline' : ''})`);
  }
  // the twin keeps what was asked for until the device reports it (a shade takes a while to roll)
  const keys = [...new Set(cmds.flatMap(c => KEYS[c.capability] ?? []))].filter(k => !expect || k in expect);
  const before = st.status[localId]?.readings ?? {};
  const target = type === 'blinds' && expect && Number.isFinite(Number(expect.pos)) ? { pos: Number(expect.pos) } : undefined;
  st.holds[localId] = { keys, before: Object.fromEntries(keys.map(k => [k, before[k]])), until: Date.now() + (target ? MOVE_MS : HOLD_MS),
    ...(target ? { target, cmds, sentAt: Date.now() } : {}) };
  st.version++;
  // read it back shortly after: most devices report within a second; a shade is followed until it arrives
  setTimeout(() => refresh(localId).catch(() => {}), 700);
  setTimeout(() => refresh(localId).catch(() => {}), 2500);
  if (target) follow(localId);
  return cmds;
}

/** HSV (SmartThings hue and saturation, 0-100) to #rrggbb at full brightness. */
export function hsvHex(hue: number, sat: number) {
  const h = (((Number(hue) || 0) * 3.6) % 360 + 360) % 360, s = clamp(Number(sat) / 100, 0, 1);
  const f = (n: number) => { const k = (n + h / 60) % 6; return 1 - s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

/** Twin readings from a SmartThings status document (only what the device reports). */
export function readingsFrom(type: string, status: any, component = 'main'): Record<string, unknown> {
  const m = status?.components?.[component] ?? {};
  const v = (cap: string, attr: string) => m?.[cap]?.[attr]?.value;
  const ts = (cap: string, attr: string) => Date.parse(m?.[cap]?.[attr]?.timestamp ?? '') || 0;
  const r: Record<string, unknown> = {};
  const sw = v('switch', 'switch');
  if (sw != null) r.on = sw === 'on';
  if (type === 'lock') { const l = v('lock', 'lock'); if (l != null) r.locked = l === 'locked'; const b = v('battery', 'battery'); if (b != null) r.batt = b; }
  if (type === 'light') {
    const lv = v('switchLevel', 'level');
    if (lv != null) { r.lv = sw === 'off' ? 0 : Number(lv); if (sw !== 'off') r.lastLv = Number(lv); }
    else if (sw != null) r.lv = sw === 'on' ? 100 : 0;
    const ct = v('colorTemperature', 'colorTemperature');
    if (ct != null) r.ct = Number(ct);
    // a colour bulb is either in white (colour temperature) or colour mode: the one set last is in use
    const hue = v('colorControl', 'hue'), sat = v('colorControl', 'saturation');
    if (hue != null && sat != null) {
      const colourAt = Math.max(ts('colorControl', 'hue'), ts('colorControl', 'saturation'));
      const whiteAt = ts('colorTemperature', 'colorTemperature');
      const colour = Number(sat) > 3 && (ct == null || colourAt > whiteAt);
      r.col = colour ? hsvHex(Number(hue), Number(sat)) : '';
    } else if (ct != null) r.col = '';
  }
  if (type === 'ac') {
    const sp = v('thermostatCoolingSetpoint', 'coolingSetpoint'); if (sp != null) r.set = sp;
    const t = v('temperatureMeasurement', 'temperature'); if (t != null) r.room = t;
    const mode = v('airConditionerMode', 'airConditionerMode'); if (mode != null) r.mode = mode === 'fanOnly' ? 'fan' : mode;
  }
  if (type === 'tv') { const vol = v('audioVolume', 'volume'); if (vol != null) r.vol = vol; }
  if (type === 'blinds') {
    const p = v('windowShadeLevel', 'shadeLevel'), s = v('windowShade', 'windowShade');
    if (p != null) r.pos = Number(p);
    else if (s != null) r.pos = s === 'open' ? 100 : s === 'closed' ? 0 : 50;
    if (s != null) r.shade = s;   // open, closed, opening, closing, partially open
  }
  if (type === 'fan') { const s = v('fanSpeed', 'fanSpeed'); if (s != null) r.speed = s; }
  if (type === 'temphum') { const t = v('temperatureMeasurement', 'temperature'); if (t != null) r.temp = t; const h = v('relativeHumidityMeasurement', 'humidity'); if (h != null) r.hum = h; }
  if (type === 'vacuum') { const s = v('robotCleanerMovement', 'robotCleanerMovement'); if (s != null) r.state = s === 'cleaning' ? 'Cleaning' : 'Docked'; }
  // any device with a power meter (smart plugs, Samsung appliances): the energy view uses the measured watts
  const pw = v('powerMeter', 'power');
  if (pw != null && Number.isFinite(Number(pw))) r.power = Number(pw);
  const en = v('energyMeter', 'energy'), eu = m?.energyMeter?.energy?.unit;
  if (en != null && Number.isFinite(Number(en))) r.energyKWh = eu === 'Wh' ? Number(en) / 1000 : Number(en);
  return r;
}

/** Store a device's new status; bumps the version when what the twin shows changes. */
function store(localId: string, readings: Record<string, unknown>, online: boolean, healthAt?: number) {
  const prev = st.status[localId];
  const l = st.links[localId];
  // a change the real device reports that the twin did not command (someone used the SmartThings app, a switch, a
  // schedule): into the journal, so the assistant knows what happened
  if (prev && l && !st.holds[localId]) {
    const changed = Object.keys(readings).filter(k => JSON.stringify(prev.readings[k]) !== JSON.stringify(readings[k]));
    if (changed.length || prev.online !== online)
      journal({ kind: 'reported', devices: [localId], text: `${l.label ?? localId} (${localId}) reported by SmartThings: ${prev.online !== online ? (online ? 'back online' : 'went OFFLINE') : changed.map(k => `${k} ${JSON.stringify(prev.readings[k] ?? null)} -> ${JSON.stringify(readings[k])}`).join(', ')}` });
  }
  st.status[localId] = { at: Date.now(), readings, online, healthAt: healthAt ?? prev?.healthAt };
  if (!prev || prev.online !== online || JSON.stringify(prev.readings) !== JSON.stringify(readings)) st.version++;
  // a hold ends as soon as the device reports a change on what the command touched; a moving device's hold ends
  // when it reports the position it was sent to (within 2 %), not at the first position on the way
  const h = st.holds[localId];
  const arrived = h?.target && Object.entries(h.target).every(([k, t]) => Number.isFinite(Number(readings[k])) && Math.abs(Number(readings[k]) - t) <= 2);
  const changed = h && h.keys.some(k => k in readings && JSON.stringify(readings[k]) !== JSON.stringify(h.before[k]));
  if (h && (Date.now() > h.until || (h.target ? arrived : changed))) {
    delete st.holds[localId]; st.version++;
  }
  if (l && !online && prev?.online !== false) st.lastError = `${l.label ?? l.stId} is offline`;
}

/** Follow a moving shade: read it every 1.5 s until it reports where it was sent. If after 12 s it has not moved
 *  at all (the motor missed the command, e.g. it was still powering up), send the command once more. */
function follow(localId: string) {
  const tick = async () => {
    const h = st.holds[localId];
    if (!h?.target) return;
    await refresh(localId).catch(() => {});
    const now = st.status[localId]?.readings ?? {};
    const still = Object.keys(h.target).every(k => JSON.stringify(now[k]) === JSON.stringify(h.before[k]));
    const moving = /ing$/.test(String(now.shade ?? ''));
    if (st.holds[localId] === h && !h.resent && still && !moving && Date.now() - (h.sentAt ?? 0) > 12_000 && h.cmds) {
      h.resent = true;
      const l = st.links[localId];
      if (l) await call(`/devices/${encodeURIComponent(l.stId)}/commands`, { method: 'POST', body: JSON.stringify({ commands: h.cmds }) }).catch(() => {});
    }
    if (st.holds[localId] === h && Date.now() < h.until) setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

/** Read one device's status now (and its health every 30 s). */
export async function refresh(localId: string, type?: string) {
  const l = st.links[localId];
  if (!l) return null;
  try {
    const s = await call(`/devices/${encodeURIComponent(l.stId)}/status`);
    const prev = st.status[localId];
    let online = prev?.online ?? true, healthAt = prev?.healthAt;
    if (!healthAt || Date.now() - healthAt > 30_000) {
      const health = await call(`/devices/${encodeURIComponent(l.stId)}/health`).catch(() => null);
      if (health?.state) { online = health.state === 'ONLINE'; healthAt = Date.now(); }
    }
    store(localId, readingsFrom(type ?? l.type, s, l.component), online, healthAt);
    const modes = s?.components?.[l.component]?.airConditionerMode?.supportedAcModes?.value;
    if (Array.isArray(modes) && modes.length) l.acModes = modes.map((m: string) => (m === 'fanOnly' ? 'fan' : m));
  } catch { store(localId, st.status[localId]?.readings ?? {}, false); }
  return st.status[localId];
}

/** All linked devices in one request (GET /devices?deviceId=…&includeStatus=true&includeHealth=true). False when
 *  the API answered without statuses (the round then reads each device). */
async function refreshBatch(): Promise<boolean> {
  const ls = Object.values(st.links);
  if (!ls.length) return true;
  const q = ls.map(l => `deviceId=${encodeURIComponent(l.stId)}`).join('&');
  const page: any = await call(`/devices?${q}&includeStatus=true&includeHealth=true`, { headers: { Accept: 'application/vnd.smartthings+json;v=20170916' } });
  const items: any[] = page?.items ?? [];
  const byStId = new Map(items.map(d => [d.deviceId, d]));
  if (!items.length || !items.some(d => (d.components ?? []).some((c: any) => c.status))) return false;
  for (const l of ls) {
    const d = byStId.get(l.stId);
    if (!d) { store(l.localId, st.status[l.localId]?.readings ?? {}, false); continue; }
    const components: Record<string, any> = {};
    for (const c of d.components ?? []) components[c.id] = c.status ?? {};
    const hs = d.healthState?.state;
    store(l.localId, readingsFrom(l.type, { components }, l.component), hs ? hs === 'ONLINE' : true, Date.now());
  }
  return true;
}

/** One polling round over every linked device. */
export async function pollOnce() {
  if (!st.token || !Object.keys(st.links).length || st.poll.running || Date.now() < st.poll.backoffUntil) return;
  st.poll.running = true;
  const t0 = Date.now();
  try {
    let done = false;
    if (st.poll.batch !== false) {
      try { done = await refreshBatch(); st.poll.batch = done; }
      catch (e) { if (st.poll.batch == null) st.poll.batch = false; else throw e; }
    }
    if (!done) {
      // per device, a few at a time
      const ids = Object.keys(st.links);
      for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(id => refresh(id)));
    }
    st.poll.lastOk = Date.now(); st.poll.errors = 0;
  } catch { st.poll.errors += 1; }
  finally { st.poll.lastAt = Date.now(); st.poll.ms = Date.now() - t0; st.poll.running = false; }
}

/** Keep linked devices' real status fresh in the background (idempotent; survives hot reloads). */
export function startPolling(before?: () => void) {
  const gg = globalThis as unknown as { __stPoll?: ReturnType<typeof setInterval>; __stPollBefore?: () => void };
  if (before) gg.__stPollBefore = before;
  if (gg.__stPoll) return;
  const round = () => { try { gg.__stPollBefore?.(); } catch { /* linking is retried next round */ } pollOnce().catch(() => {}); };
  // per-device reads (no batch) are slower and count against the rate limit: poll them less often
  gg.__stPoll = setInterval(() => { if (st.poll.batch === false && Date.now() - st.poll.lastAt < Math.max(POLL_MS, 4000)) return; round(); }, POLL_MS);
  round();
}

/** Last real status of a linked device, with the values of a command still on its way kept out of it. */
export function realState(localId: string, type: string) {
  if (!st.links[localId]) return null;
  const s = st.status[localId];
  if (!s) { refresh(localId, type).catch(() => {}); return null; }
  if (Date.now() - s.at > Math.max(POLL_MS * 5, 15_000)) refresh(localId, type).catch(() => {});
  const h = st.holds[localId];
  if (h && Date.now() <= h.until) {
    const readings = { ...s.readings };
    for (const k of h.keys) delete readings[k];
    return { ...s, readings, pending: h.keys };
  }
  return s;
}

/** The commands a linked device really supports: a command stays only if every SmartThings capability it needs is
 *  on the device, and the AC's mode list is narrowed to the modes the unit reports. Unlinked: all of them. */
export function supported<T extends { name: string; args: Record<string, any> }>(localId: string, type: string, cmds: T[]): T[] {
  const l = st.links[localId];
  if (!l?.capabilities?.length) return cmds;
  const caps = new Set(l.capabilities);
  const sample: Record<string, unknown> = { on: 'true', percent: 50, celsius: 24, mode: 'cool', position: 'swing', hours: 1, kelvin: 3000, source: 'HDMI 1', level: 2, color: 'pink', hue: 50, saturation: 80 };
  return cmds
    .filter(c => { const t = translate(type, c.name, sample, l.component); return !!t && t.every(x => caps.has(x.capability)); })
    .map(c => (c.name === 'setMode' && l.acModes?.length ? { ...c, args: { ...c.args, mode: (c.args.mode as string[]).filter(m => l.acModes!.includes(m)) } } : c));
}
