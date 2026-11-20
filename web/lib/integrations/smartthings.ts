// SmartThings connector: a device on the twin can be linked to a real SmartThings device. Commands to a linked
// device go to the SmartThings REST API (POST /v1/devices/{id}/commands, Bearer personal access token or OAuth
// token); its real status (GET /v1/devices/{id}/status) replaces the simulated readings it covers.
// Unlinked devices keep using the simulator, so a floor can mix real and simulated devices.
//
// Configure with SMARTTHINGS_TOKEN (and SMARTTHINGS_API for a different base URL, e.g. a test double), or enter a
// token on /integrations (kept in memory only).

export type Link = { localId: string; stId: string; component: string; label?: string; type: string; capabilities?: string[]; acModes?: string[] };
type StCommand = { component: string; capability: string; command: string; arguments: unknown[] };

type State = { token: string; links: Record<string, Link>; status: Record<string, { at: number; readings: Record<string, unknown>; online: boolean }>; lastError: string };
const g = globalThis as unknown as { __st?: State };
const st: State = (g.__st ??= { token: process.env.SMARTTHINGS_TOKEN ?? '', links: {}, status: {}, lastError: '' });

const base = () => (process.env.SMARTTHINGS_API ?? 'https://api.smartthings.com/v1').replace(/\/$/, '');
export const configured = () => !!st.token;
export function setToken(token: string) { st.token = token.trim(); st.lastError = ''; }
export function links() { return Object.values(st.links); }
export function link(localId: string) { return st.links[localId] ?? null; }
export function setLink(l: Link) { st.links[l.localId] = { ...l, component: l.component || 'main' }; delete st.status[l.localId]; }
export function unlink(localId: string) { delete st.links[localId]; delete st.status[localId]; }
export function info() { return { configured: configured(), api: base(), links: links(), lastError: st.lastError }; }

async function call(path: string, init: RequestInit = {}) {
  if (!st.token) throw new Error('SmartThings is not connected (no token)');
  const r = await fetch(`${base()}${path}`, { ...init, headers: { Authorization: `Bearer ${st.token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
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
    case 'light.setLevel': return Number(a.percent) <= 0 ? [c('switch', 'off')] : [c('switch', 'on'), c('switchLevel', 'setLevel', [Math.round(Number(a.percent))])];
    case 'light.setColor': {
      // SmartThings colorControl takes hue and saturation on a 0-100 scale
      const hex = String(({ pink: '#ff6fae', purple: '#8b5cf6', blue: '#3b82f6', cyan: '#22d3ee', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' } as Record<string, string>)[String(a.color)] ?? '#ffffff');
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [c('switch', 'on'), c('colorControl', 'setColor', [{ hue: Math.round(((h * 60 + 360) % 360) / 3.6), saturation: Math.round((mx ? d / mx : 0) * 100) }])];
    }
    case 'light.setColorTemperature': return [c('colorTemperature', 'setColorTemperature', [Math.round(Number(a.kelvin))])];
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
    case 'blinds.setPosition': return [c('windowShadeLevel', 'setShadeLevel', [Math.round(Number(a.percent))])];
    case 'purifier.setFan': return [c('switch', 'on'), c('airPurifierFanMode', 'setAirPurifierFanMode', [['sleep', 'low', 'medium', 'high', 'auto'][Math.max(0, Math.min(4, Number(a.level) - 1))]])];
    case 'vacuum.start': return [c('robotCleanerMovement', 'setRobotCleanerMovement', ['cleaning'])];
    case 'vacuum.dock': return [c('robotCleanerMovement', 'setRobotCleanerMovement', ['homing'])];
  }
  return null;
}

/** Sends a twin command to the linked SmartThings device. */
export async function send(localId: string, type: string, command: string, args: Record<string, unknown>) {
  const l = st.links[localId];
  if (!l) throw new Error(`${localId} is not linked to SmartThings`);
  const cmds = translate(type, command, args, l.component);
  if (!cmds) throw new Error(`"${command}" has no SmartThings equivalent for this device`);
  await call(`/devices/${encodeURIComponent(l.stId)}/commands`, { method: 'POST', body: JSON.stringify({ commands: cmds }) });
  refresh(localId).catch(() => {});
  return cmds;
}

/** Twin readings from a SmartThings status document (only what the device reports). */
export function readingsFrom(type: string, status: any, component = 'main'): Record<string, unknown> {
  const m = status?.components?.[component] ?? {};
  const v = (cap: string, attr: string) => m?.[cap]?.[attr]?.value;
  const r: Record<string, unknown> = {};
  const sw = v('switch', 'switch');
  if (sw != null) r.on = sw === 'on';
  if (type === 'lock') { const l = v('lock', 'lock'); if (l != null) r.locked = l === 'locked'; const b = v('battery', 'battery'); if (b != null) r.batt = b; }
  if (type === 'light') { const lv = v('switchLevel', 'level'); if (lv != null) r.lv = sw === 'off' ? 0 : lv; else if (sw != null) r.lv = sw === 'on' ? 100 : 0; const ct = v('colorTemperature', 'colorTemperature'); if (ct != null) r.ct = ct; }
  if (type === 'ac') {
    const sp = v('thermostatCoolingSetpoint', 'coolingSetpoint'); if (sp != null) r.set = sp;
    const t = v('temperatureMeasurement', 'temperature'); if (t != null) r.room = t;
    const mode = v('airConditionerMode', 'airConditionerMode'); if (mode != null) r.mode = mode === 'fanOnly' ? 'fan' : mode;
  }
  if (type === 'tv') { const vol = v('audioVolume', 'volume'); if (vol != null) r.vol = vol; }
  if (type === 'blinds') { const p = v('windowShadeLevel', 'shadeLevel'); if (p != null) r.pos = p; else { const s = v('windowShade', 'windowShade'); if (s != null) r.pos = s === 'open' ? 100 : s === 'closed' ? 0 : 50; } }
  if (type === 'fan') { const s = v('fanSpeed', 'fanSpeed'); if (s != null) r.speed = s; }
  if (type === 'temphum') { const t = v('temperatureMeasurement', 'temperature'); if (t != null) r.temp = t; const h = v('relativeHumidityMeasurement', 'humidity'); if (h != null) r.hum = h; }
  if (type === 'vacuum') { const s = v('robotCleanerMovement', 'robotCleanerMovement'); if (s != null) r.state = s === 'cleaning' ? 'Cleaning' : 'Docked'; }
  return r;
}

export async function refresh(localId: string, type?: string) {
  const l = st.links[localId];
  if (!l) return null;
  try {
    const s = await call(`/devices/${encodeURIComponent(l.stId)}/status`);
    const health = await call(`/devices/${encodeURIComponent(l.stId)}/health`).catch(() => null);
    st.status[localId] = { at: Date.now(), readings: readingsFrom(type ?? l.type, s, l.component), online: health?.state ? health.state === 'ONLINE' : true };
    const modes = s?.components?.[l.component]?.airConditionerMode?.supportedAcModes?.value;
    if (Array.isArray(modes) && modes.length) l.acModes = modes.map((m: string) => (m === 'fanOnly' ? 'fan' : m));
  } catch { st.status[localId] = { at: Date.now(), readings: st.status[localId]?.readings ?? {}, online: false }; }
  return st.status[localId];
}

/** Last real status of a linked device (refreshed in the background every 10 s), or null. */
export function realState(localId: string, type: string) {
  if (!st.links[localId]) return null;
  const s = st.status[localId];
  if (!s || Date.now() - s.at > 10_000) refresh(localId, type).catch(() => {});
  return s ?? null;
}

/** The commands a linked device really supports: a command stays only if every SmartThings capability it needs is
 *  on the device, and the AC's mode list is narrowed to the modes the unit reports. Unlinked: all of them. */
export function supported<T extends { name: string; args: Record<string, any> }>(localId: string, type: string, cmds: T[]): T[] {
  const l = st.links[localId];
  if (!l?.capabilities?.length) return cmds;
  const caps = new Set(l.capabilities);
  const sample: Record<string, unknown> = { on: 'true', percent: 50, celsius: 24, mode: 'cool', position: 'swing', hours: 1, kelvin: 3000, source: 'HDMI 1', level: 2, color: 'pink' };
  return cmds
    .filter(c => { const t = translate(type, c.name, sample, l.component); return !!t && t.every(x => caps.has(x.capability)); })
    .map(c => (c.name === 'setMode' && l.acModes?.length ? { ...c, args: { ...c.args, mode: (c.args.mode as string[]).filter(m => l.acModes!.includes(m)) } } : c));
}
