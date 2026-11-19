// @ts-nocheck
// Device simulator and rule engine (ported from the HTML prototype).
// Single source of truth for readings, part health and findings.
import building from './data/building.json';
import devices from './data/devices.json';

// The layout (rooms + devices) can be replaced at runtime by an uploaded floor plan (setLayout).
// All mutable state lives on globalThis and is mutated in place: Next.js may load this module once per
// route bundle, and every copy must see the same layout, scenario and clock.
const G = ((globalThis as any).__twinEngine ??= {
  ROOMS: [], DEV: [], byId: {}, init: false,
  LAYOUT: { outdoorPad: building.outdoorPad, wallHeight: building.wallHeight, version: 0, custom: false },
  R: { odu: null, far: [], circuit: [], filterAc: null, washer: null, leak: null, lowBatt: null, farNames: '' },
  state: { scen: 'normal', fixT: null },
  scenNames: {},
});
export const ROOMS: any[] = G.ROOMS;
export const DEV: any[] = G.DEV;
export const byId: Record<string, any> = G.byId;
export const LAYOUT: { outdoorPad: any; wallHeight: number; version: number; custom: boolean } = G.LAYOUT;

/** Devices that each scenario acts on. Chosen from the layout, so scenarios work on any uploaded plan. */
export const R: { odu: string | null; far: string[]; circuit: string[]; filterAc: string | null; washer: string | null; leak: string | null; lowBatt: string | null; farNames: string } = G.R;

export function setLayout(rooms: any[], devices: any[], extra: { outdoorPad?: any; wallHeight?: number; custom?: boolean } = {}) {
  ROOMS.splice(0, ROOMS.length, ...rooms);
  const counters = {};
  DEV.splice(0, DEV.length, ...devices.map(d => ({ ...d, p: d.position, n: (counters[d.type] = (counters[d.type] ?? -1) + 1) })));
  for (const k of Object.keys(byId)) delete byId[k];
  for (const d of DEV) byId[d.id] = d;
  if (extra.outdoorPad) LAYOUT.outdoorPad = extra.outdoorPad;
  if (extra.wallHeight) LAYOUT.wallHeight = extra.wallHeight;
  LAYOUT.custom = !!extra.custom;
  LAYOUT.version++;
  const of = (type) => DEV.filter(d => d.type === type);
  const dist = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]);
  const odus = of('odu'), odu = odus[0], acs = of('ac'), washer = of('washer')[0];
  R.odu = odu?.id ?? null;
  // Same rule as the renderer's piping: each indoor unit is on the circuit of its nearest outdoor unit.
  const nearest = (d) => odus.reduce((best, o) => (dist(d, o) < dist(d, best) ? o : best), odus[0]);
  const circuit = odu ? acs.filter(d => nearest(d) === odu) : acs;
  R.far = (odu ? [...circuit].sort((a, b) => dist(b, odu) - dist(a, odu)) : [...circuit].reverse()).slice(0, 2).map(d => d.id).reverse();
  R.circuit = circuit.map(d => d.id);
  const roomName = (k) => ROOMS.find(r => r.key === k)?.name ?? k;
  const bed = acs.find(d => /bed/i.test(roomName(d.room)) && !/primary|master/i.test(roomName(d.room)));
  R.filterAc = (bed ?? acs.find(d => !R.far.includes(d.id)) ?? acs[0])?.id ?? null;
  R.washer = washer?.id ?? null;
  const leaks = of('leak');
  R.leak = (washer ? [...leaks].sort((a, b) => dist(a, washer) - dist(b, washer))[0] : leaks[0])?.id ?? null;
  R.lowBatt = of('motion')[0]?.id ?? null;
  R.farNames = R.far.map(id => roomName(byId[id].room)).join(', ');
  // Scenario names follow the layout, so the picker reads right on an uploaded plan.
  G.scenNames.filter = R.filterAc ? `Scenario 1 · ${roomName(byId[R.filterAc].room)} AC: blocked airflow` : undefined;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const SCEN: Record<string, any> = {
  normal: { name: 'Normal day', onset: null },
  filter: { name: 'Scenario 1 · Bedroom AC: blocked airflow', onset: 11.3, ramp: 1.2 },
  refrig: { name: 'Scenario 2 · Refrigerant shortage (whole system)', onset: 9, ramp: 4 },
  washer: { name: 'Scenario 3 · Washer drain fault and water leak', onset: 14, ramp: .2 },
};
export const state: { scen: string; fixT: number | null } = G.state;
function sev(t) { const s = SCEN[state.scen]; if (!s.onset) return 0; let v = clamp((t - s.onset) / s.ramp, 0, 1); if (state.fixT != null && t >= state.fixT) v *= clamp(1 - (t - state.fixT) / .5, 0, 1); return v; }
const occ = (room, t) => ({ media: t > 19, living: (t > 9 && t < 12) || t > 17, kitchen: (t > 6.5 && t < 8.5) || (t > 17.5 && t < 20), primary: t < 7.5 || t > 21, bedroom: t < 7.5 || t > 10.5, dining: (t > 7 && t < 8.5) || (t > 18.5 && t < 20.5), bath: (t > 6.5 && t < 7.5) || t > 21.5, laundry: t > 13.5 && t < 16 }[room] ?? (t > 7 && t < 9 || t > 18 && t < 23));
function acRead(d, t) {
  const w = Math.sin(t * 1.3 + (d.n % 6)) * .25;
  const r = { on: true, set: 24, room: 24 + w * .6, evIn: 7 + w * .3, evOut: 12 + w * .3, fan: 55, air: 100, louver: 35, drain: 'Flowing', rssi: -52 - (d.n % 6) * 3, err: null };
  const s = sev(t);
  if (state.scen === 'filter' && d.id === R.filterAc) { r.air = 100 - 55 * s; r.fan = 55 + 45 * s; r.evIn = 7 - 6 * s; r.evOut = 12 - 8 * s; r.room += 3.5 * s; }
  if (state.scen === 'refrig' && R.circuit.includes(d.id)) { const f = R.far.includes(d.id) ? 1 : .3; r.evIn += 3 * s * f; r.evOut += 9 * s * f; r.room += 2.5 * s * f; r.fan += 20 * s * f; }
  r.sh = r.evOut - r.evIn; r.amps = .18 + r.fan * .004; return r;
}
/* Only the outdoor unit on the leaking circuit shows the shortage. */ function oduRead(t, id = R.odu) { const s = state.scen === 'refrig' && id === R.odu ? sev(t) : 0; return { dis: 74 + 34 * s, suc: 12 + 7 * s, lp: 9.4 - 2.4 * s, hp: 26 - 3 * s, hz: 58 + 30 * s, fan: 26, eev: Math.round(300 + 180 * s) }; }
const LT_LEVEL = { media: 40, living: 80, kitchen: 90, primary: 50, bedroom: 60, dining: 75, bath: 85, laundry: 90 };
function read(d, t) {
  const s = sev(t), o = occ(d.room, t);
  switch (d.type) {
    case 'ac': return acRead(d, t);
    case 'odu': return oduRead(t, d.id);
    case 'light': { const lv = o ? (LT_LEVEL[d.room] ?? 70) : 0; return { lv, ma: lv * 4.1, ledT: 28 + lv * .22, rssi: -55 - (d.n % 6) * 2 }; }
    case 'tv': return { on: o && d.room === 'media' ? true : (o && t > 19), w: o ? 112 : 0.5, rssi: -48 };
    case 'speaker': return { on: o, vol: o ? 30 : 0, rssi: -50 - (d.n % 6) };
    case 'blinds': return { pos: t > 7 && t < 19.5 ? 100 : 0, batt: 64 - (d.n % 6) * 4, rssi: -62 };
    case 'fridge': return { fz: 3.1 + Math.sin(t * 3) * .3, fr: -18.2 + Math.sin(t * 2) * .4, comp: Math.sin(t * 6) > -.2 ? 'Running' : 'Idle', door: 'Closed', w: 95 };
    case 'oven': return { on: t > 18 && t < 19, temp: t > 18 && t < 19 ? 180 : 24 };
    case 'vacuum': return { batt: t > 10 && t < 11 ? Math.round(100 - (t - 10) * 60) : 100, state: t > 10 && t < 11 ? 'Cleaning' : 'Docked', bin: 35 };
    case 'camera': return { on: true, rec: true, rssi: -58 - (d.n % 6) * 4 };
    case 'doorbell': return { batt: 71, rssi: -66, presses: Math.floor(Math.max(0, t - 9) / 4) };
    case 'lock': return { locked: !(t > 8.3 && t < 8.4), batt: 58, rssi: -64 };
    case 'washer': {
      const run = t > 13.5 && t < 15.5; const f = state.scen === 'washer' ? s : 0; const stuck = f > 0 && (state.fixT == null || t < state.fixT);
      return { state: stuck && t > 14.1 ? 'Stopped · drain error' : run ? 'Washing' : 'Idle', motor: run && !(stuck && t > 14.1) ? 1200 : 0, pump: f > 0 ? 0 : (run ? .22 : 0), level: f > 0 ? 'High (not draining)' : run ? 'Normal' : 'Empty', lockd: run ? 'Locked' : 'Open', valve: run && !stuck ? 'Open' : 'Closed', err: stuck && t > 14.1 ? 'Drain error (mock code)' : null };
    }
    case 'dryer': return { state: t > 15.5 && t < 16.5 ? 'Drying' : 'Idle', heat: t > 15.5 && t < 16.5 ? 'On' : 'Off', lint: 'Clean', temp: t > 15.5 && t < 16.5 ? 62 : 25 };
    case 'leak': { const wet = d.id === R.leak && state.scen === 'washer' && t > 14.3 && (state.fixT == null || t < state.fixT + .3); return { wet, batt: 88 - (d.n % 6) * 5, rssi: -60 - (d.n % 6) * 3 }; }
    case 'temphum': return { temp: 24.5 + (occ('bath', t) ? 1.5 : 0), hum: occ('bath', t) ? 78 : 55, batt: 81, rssi: -63 };
    case 'motion': return { motion: o && Math.sin(t * 9 + d.n) > 0, batt: d.id === R.lowBatt ? 12 : 74, rssi: -61 - (d.n % 6) * 2 };
    case 'plug': return { on: true, w: o ? 42 : 3.2, kwh: ((t - 6) * .05).toFixed(2), rssi: -57 };
    case 'purifier': return { fan: o ? 3 : 1, pm: 8 + (o ? 4 : 0), hepa: 62 };
  }
}


const H = (c) => c;
const radio = (k = 'radio', n = 'Wireless radio') => ({ key: k, name: n, shape: 'box', size: [.05, .006, .04], col: 0x1d7a4a, val: r => `${r.rssi} dBm`, h: r => r.rssi < -85 ? 'watch' : 'ok', s: r => r.rssi, u: 'dBm' });
const batt = (cell = 'Battery') => ({ key: 'batt', name: cell, shape: 'cyl', size: [.012, .035], col: 0x6b7280, val: r => `${r.batt} %`, h: r => r.batt < 10 ? 'fault' : r.batt < 20 ? 'watch' : 'ok', s: r => r.batt, u: '%' });
export const TYPES: Record<string, any> = {
  ac: { label: 'Air conditioner', icon: '<rect x="3" y="6" width="18" height="8" rx="2"/><path d="M7 18v2M12 18v3M17 18v2"/>', custom: 'ac', cam: 2.3,
    parts: [
      { key: 'filter', name: 'Air filter', val: r => `airflow ${r.air.toFixed(0)} %`, h: r => r.air < 70 ? 'fault' : r.air < 88 ? 'watch' : 'ok', note: 'no sensor · inferred', s: r => r.air, u: '%' },
      { key: 'fan', name: 'Cross-flow fan', val: r => `${r.fan.toFixed(0)} % speed`, h: r => r.fan >= 95 ? 'watch' : 'ok', s: r => r.fan, u: '%' },
      { key: 'motor', name: 'Fan motor', val: r => `${r.amps.toFixed(2)} A`, h: r => r.amps > .55 ? 'watch' : 'ok', s: r => r.amps, u: 'A' },
      { key: 'coil', name: 'Evaporator coil', val: r => `in ${r.evIn.toFixed(1)}° · out ${r.evOut.toFixed(1)}°`, h: r => r.evIn < 3 || r.sh > 10 ? 'watch' : 'ok', s: r => r.evIn, u: '°C' },
      { key: 'coilsens', name: 'Coil temp. sensor', val: r => `${r.evIn.toFixed(1)} °C`, h: () => 'ok', s: r => r.evIn, u: '°C' },
      { key: 'roomsens', name: 'Room temp. sensor', val: r => `${r.room.toFixed(1)} °C (set ${r.set})`, h: () => 'ok', s: r => r.room, u: '°C' },
      { key: 'louver', name: 'Louver motor', val: r => `angle ${r.louver}°`, h: () => 'ok', s: r => r.louver, u: '°' },
      { key: 'drain', name: 'Drain pan and hose', val: r => r.drain, h: () => 'ok', s: () => 0, u: '' },
      { key: 'pcb', name: 'Control board', val: r => r.err || 'No error', h: r => r.err ? 'watch' : 'ok', s: r => r.err ? 1 : 0, u: '' },
      { key: 'wifi', name: 'Wi-Fi module', val: r => `${r.rssi} dBm`, h: () => 'ok', s: r => r.rssi, u: 'dBm' },
    ] },
  odu: { label: 'Outdoor unit', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="4.5"/>', custom: 'odu', cam: 3.2,
    parts: [
      { key: 'comp', name: 'Compressor', val: o => `discharge ${o.dis.toFixed(1)} °C · ${o.hz.toFixed(0)} Hz`, h: o => o.dis > 110 ? 'fault' : o.dis > 100 ? 'watch' : 'ok', s: o => o.dis, u: '°C' },
      { key: 'lp', name: 'Low-pressure sensor', val: o => `${o.lp.toFixed(1)} kgf/cm²`, h: o => o.lp < 7.5 ? 'watch' : 'ok', s: o => o.lp, u: 'kgf/cm²' },
      { key: 'acc', name: 'Accumulator · suction', val: o => `suction ${o.suc.toFixed(1)} °C`, h: o => o.suc > 17 ? 'watch' : 'ok', s: o => o.suc, u: '°C' },
      { key: 'eev', name: 'Expansion valves', val: o => `${o.eev} step`, h: o => o.eev >= 470 ? 'watch' : 'ok', s: o => o.eev, u: 'step' },
      { key: 'hp', name: 'High-pressure sensor', val: o => `${o.hp.toFixed(1)} kgf/cm²`, h: () => 'ok', s: o => o.hp, u: 'kgf/cm²' },
      { key: 'fw', name: '4-way valve', val: () => 'Cooling', h: () => 'ok', s: () => 0, u: '' },
      { key: 'coil', name: 'Outdoor coil', val: () => 'clean · 38 °C', h: () => 'ok', s: () => 38, u: '°C' },
      { key: 'fans', name: 'Fan', val: o => `step ${o.fan}`, h: () => 'ok', s: o => o.fan, u: 'step' },
      { key: 'inv', name: 'Inverter board', val: () => 'No error', h: () => 'ok', s: () => 0, u: '' },
    ] },
  light: { label: 'Smart light', icon: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>', cam: 1.1, sf: 1, er: .32,
    parts: [{ key: 'led', name: 'LED board', shape: 'cyl', size: [.2, .01], col: 0xfef3c7, val: r => `${r.lv} % · ${r.ledT.toFixed(0)} °C`, h: () => 'ok', s: r => r.lv, u: '%' },
      { key: 'driver', name: 'LED driver', shape: 'box', size: [.12, .035, .07], col: 0x475569, val: r => `${r.ma.toFixed(0)} mA`, h: () => 'ok', s: r => r.ma, u: 'mA' },
      { key: 'diff', name: 'Diffuser', shape: 'cyl', size: [.23, .008], col: 0xf8fafc, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' }, radio()] },
  tv: { label: 'TV', icon: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8"/>', cam: 2.2, sf: 1, er: .7,
    parts: [{ key: 'panel', name: 'Display panel', shape: 'box', size: [1.2, .68, .02], col: 0x111827, val: r => r.on ? 'On' : 'Standby', h: () => 'ok', s: r => r.on ? 1 : 0, u: '' },
      { key: 'main', name: 'Main board', shape: 'box', size: [.3, .2, .02], col: 0x1d7a4a, val: () => 'No error', h: () => 'ok', s: () => 0, u: '' },
      { key: 'psu', name: 'Power supply', shape: 'box', size: [.25, .15, .03], col: 0x475569, val: r => `${r.w} W`, h: () => 'ok', s: r => r.w, u: 'W' }, radio('wifi', 'Wi-Fi module')] },
  speaker: { label: 'Speaker', icon: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14" r="3"/><circle cx="12" cy="7.5" r="1"/>', cam: .9, sf: 2, er: .16,
    parts: [{ key: 'woofer', name: 'Driver', shape: 'cyl', size: [.05, .03], col: 0x334155, val: r => `vol ${r.vol}`, h: () => 'ok', s: r => r.vol, u: '' },
      { key: 'amp', name: 'Amplifier', shape: 'box', size: [.06, .04, .01], col: 0x1d7a4a, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' },
      { key: 'mic', name: 'Mic array', shape: 'cyl', size: [.03, .005], col: 0x64748b, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' }, radio('wifi', 'Wi-Fi module')] },
  blinds: { label: 'Smart blinds', icon: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M4 7h16M4 11h16M4 15h16"/>', cam: 1.6, sf: 1, er: .45,
    parts: [{ key: 'motor', name: 'Tube motor', shape: 'cyl', size: [.03, .5], col: 0x475569, val: r => `position ${r.pos} %`, h: () => 'ok', s: r => r.pos, u: '%' }, batt('Battery pack'), radio()] },
  fridge: { label: 'Refrigerator', icon: '<rect x="6" y="2.5" width="12" height="19" rx="1.5"/><path d="M6 9h12M9 5.5v1.5M9 12v3"/>', cam: 2.6, sf: 1, er: .7,
    parts: [{ key: 'comp', name: 'Compressor', shape: 'cyl', size: [.1, .2], col: 0x1d2433, val: r => r.comp, h: () => 'ok', s: r => r.comp === 'Running' ? 1 : 0, u: '' },
      { key: 'cond', name: 'Condenser coil', shape: 'box', size: [.5, .3, .03], col: 0x9aa6b8, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' },
      { key: 'evap', name: 'Evaporator', shape: 'box', size: [.4, .25, .03], col: 0xbfdcff, val: () => 'No frost', h: () => 'ok', s: () => 0, u: '' },
      { key: 'ftemp', name: 'Fridge sensor', shape: 'sph', size: [.025], col: 0xe24b4a, val: r => `${r.fz.toFixed(1)} °C`, h: r => r.fz > 6 ? 'watch' : 'ok', s: r => r.fz, u: '°C' },
      { key: 'ztemp', name: 'Freezer sensor', shape: 'sph', size: [.025], col: 0x2563eb, val: r => `${r.fr.toFixed(1)} °C`, h: r => r.fr > -12 ? 'watch' : 'ok', s: r => r.fr, u: '°C' },
      { key: 'door', name: 'Door switch', shape: 'box', size: [.04, .02, .02], col: 0xf59e0b, val: r => r.door, h: () => 'ok', s: () => 0, u: '' }] },
  oven: { label: 'Oven', icon: '<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><rect x="6.5" y="9" width="11" height="8" rx="1"/><path d="M7 6.5h1M10 6.5h1"/>', cam: 1.7, sf: 1, er: .45,
    parts: [{ key: 'elem', name: 'Heating element', shape: 'box', size: [.4, .02, .3], col: 0xb45309, val: r => r.on ? 'On' : 'Off', h: () => 'ok', s: r => r.on ? 1 : 0, u: '' },
      { key: 'probe', name: 'Cavity temp. sensor', shape: 'cyl', size: [.01, .12], col: 0xe24b4a, val: r => `${r.temp} °C`, h: () => 'ok', s: r => r.temp, u: '°C' },
      { key: 'fan', name: 'Convection fan', shape: 'cyl', size: [.08, .02], col: 0x64748b, val: r => r.on ? 'Running' : 'Off', h: () => 'ok', s: () => 0, u: '' },
      { key: 'pcb', name: 'Control board', shape: 'box', size: [.15, .08, .01], col: 0x1d7a4a, val: () => 'No error', h: () => 'ok', s: () => 0, u: '' }] },
  vacuum: { label: 'Robot vacuum', icon: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="9" r="2"/>', cam: 1.0, sf: 1.6, er: .26,
    parts: [batt(), { key: 'brush', name: 'Brush motor', shape: 'cyl', size: [.02, .14], col: 0x334155, val: r => r.state, h: () => 'ok', s: () => 0, u: '' },
      { key: 'lidar', name: 'Lidar sensor', shape: 'cyl', size: [.04, .02], col: 0x1d2433, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' },
      { key: 'bin', name: 'Dust bin', shape: 'box', size: [.1, .04, .06], col: 0x94a3b8, val: r => `${r.bin} % full`, h: r => r.bin > 90 ? 'watch' : 'ok', s: r => r.bin, u: '%' }] },
  camera: { label: 'Camera', icon: '<circle cx="12" cy="10" r="6"/><circle cx="12" cy="10" r="2.5"/><path d="M9 20h6M12 16v4"/>', cam: .8, sf: 3, er: .09,
    parts: [{ key: 'img', name: 'Image sensor', shape: 'box', size: [.02, .02, .004], col: 0x1d2433, val: r => r.rec ? 'Recording' : 'Off', h: () => 'ok', s: () => 1, u: '' },
      { key: 'ir', name: 'IR LEDs', shape: 'cyl', size: [.012, .004], col: 0x7f1d1d, val: () => 'Auto', h: () => 'ok', s: () => 0, u: '' },
      { key: 'mic', name: 'Microphone', shape: 'sph', size: [.006], col: 0x64748b, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' }, radio('wifi', 'Wi-Fi module')] },
  doorbell: { label: 'Video doorbell', icon: '<rect x="8" y="2.5" width="8" height="19" rx="4"/><circle cx="12" cy="8" r="1.8"/><circle cx="12" cy="15" r="2.3"/>', cam: .8, sf: 3, er: .09,
    parts: [{ key: 'cam', name: 'Camera module', shape: 'box', size: [.02, .02, .006], col: 0x1d2433, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' },
      { key: 'btn', name: 'Button', shape: 'cyl', size: [.012, .005], col: 0x94a3b8, val: r => `${r.presses} presses today`, h: () => 'ok', s: r => r.presses, u: '' }, batt(), radio('wifi', 'Wi-Fi module')] },
  lock: { label: 'Door lock', icon: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3"/>', cam: .8, sf: 3, er: .09,
    parts: [{ key: 'bolt', name: 'Bolt motor', shape: 'box', size: [.04, .012, .012], col: 0x94a3b8, val: r => r.locked ? 'Locked' : 'Unlocked', h: () => 'ok', s: r => r.locked ? 1 : 0, u: '' },
      { key: 'keypad', name: 'Keypad', shape: 'box', size: [.03, .05, .005], col: 0x1d2433, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' }, batt('Battery (4 × AA)'), radio()] },
  washer: { label: 'Washer', icon: '<rect x="4" y="2.5" width="16" height="19" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M7 6h2"/>', cam: 1.9, sf: 1, er: .55,
    parts: [{ key: 'pump', name: 'Drain pump', shape: 'box', size: [.1, .08, .08], col: 0x34445f, val: r => `${r.pump.toFixed(2)} A`, h: r => r.err ? 'fault' : 'ok', s: r => r.pump, u: 'A' },
      { key: 'level', name: 'Water level sensor', shape: 'cyl', size: [.015, .05], col: 0x2563eb, val: r => r.level, h: r => r.err ? 'watch' : 'ok', s: r => r.level.startsWith('High') ? 2 : r.level === 'Normal' ? 1 : 0, u: '' },
      { key: 'motor', name: 'Drum motor', shape: 'cyl', size: [.08, .1], col: 0x475569, val: r => `${r.motor} rpm`, h: () => 'ok', s: r => r.motor, u: 'rpm' },
      { key: 'valve', name: 'Water inlet valve', shape: 'box', size: [.05, .04, .04], col: 0x2f6fed, val: r => r.valve, h: () => 'ok', s: r => r.valve === 'Open' ? 1 : 0, u: '' },
      { key: 'dlock', name: 'Door lock', shape: 'box', size: [.04, .03, .02], col: 0xf59e0b, val: r => r.lockd, h: () => 'ok', s: () => 0, u: '' },
      { key: 'pcb', name: 'Control board', shape: 'box', size: [.16, .1, .01], col: 0x1d7a4a, val: r => r.err || 'No error', h: r => r.err ? 'watch' : 'ok', s: r => r.err ? 1 : 0, u: '' }] },
  dryer: { label: 'Dryer', icon: '<rect x="4" y="2.5" width="16" height="19" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M10 12a2 2 0 1 1 2 3M7 6h2M11 6h1"/>', cam: 1.9, sf: 1, er: .55,
    parts: [{ key: 'heat', name: 'Heater', shape: 'box', size: [.3, .03, .08], col: 0xb45309, val: r => r.heat, h: () => 'ok', s: () => 0, u: '' },
      { key: 'motor', name: 'Drum motor', shape: 'cyl', size: [.08, .1], col: 0x475569, val: r => r.state, h: () => 'ok', s: () => 0, u: '' },
      { key: 'lint', name: 'Lint filter', shape: 'box', size: [.2, .01, .12], col: 0xcbd5e1, val: r => r.lint, h: () => 'ok', s: () => 0, u: '' },
      { key: 'temp', name: 'Exhaust temp. sensor', shape: 'sph', size: [.015], col: 0xe24b4a, val: r => `${r.temp} °C`, h: () => 'ok', s: r => r.temp, u: '°C' }] },
  leak: { label: 'Water leak sensor', icon: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>', cam: .7, sf: 3, er: .08,
    parts: [{ key: 'probe', name: 'Water probes', shape: 'cyl', size: [.006, .02], col: 0xb8c2d1, val: r => r.wet ? 'WET' : 'Dry', h: r => r.wet ? 'fault' : 'ok', s: r => r.wet ? 1 : 0, u: '' }, batt('Battery (CR2032)'), radio()] },
  temphum: { label: 'Temp. and humidity sensor', icon: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v6"/>', cam: .7, sf: 3, er: .08,
    parts: [{ key: 'temp', name: 'Temperature sensor', shape: 'sph', size: [.006], col: 0xe24b4a, val: r => `${r.temp.toFixed(1)} °C`, h: () => 'ok', s: r => r.temp, u: '°C' },
      { key: 'hum', name: 'Humidity sensor', shape: 'box', size: [.01, .01, .003], col: 0x2563eb, val: r => `${r.hum} %`, h: r => r.hum > 85 ? 'watch' : 'ok', s: r => r.hum, u: '%' }, batt('Battery (CR2032)'), radio()] },
  motion: { label: 'Motion sensor', icon: '<circle cx="12" cy="5" r="2"/><path d="M9 21l2-6 2 2v4M11 15l-1-5 4 1 2 3M10 10l-3 2"/>', cam: .7, sf: 3, er: .08,
    parts: [{ key: 'pir', name: 'PIR motion sensor', shape: 'cyl', size: [.008, .008], col: 0x334155, val: r => r.motion ? 'Motion' : 'No motion', h: () => 'ok', s: r => r.motion ? 1 : 0, u: '' },
      { key: 'lens', name: 'Fresnel lens', shape: 'sph', size: [.016], col: 0xf8fafc, val: () => 'OK', h: () => 'ok', s: () => 0, u: '' }, batt('Battery (CR123A)'), radio()] },
  plug: { label: 'Smart plug', icon: '<path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4"/>', cam: .7, sf: 3, er: .08,
    parts: [{ key: 'relay', name: 'Relay', shape: 'box', size: [.02, .015, .015], col: 0x1d2433, val: r => r.on ? 'On' : 'Off', h: () => 'ok', s: () => 1, u: '' },
      { key: 'meter', name: 'Power meter', shape: 'box', size: [.012, .003, .012], col: 0x1d7a4a, val: r => `${r.w} W · ${r.kwh} kWh`, h: () => 'ok', s: r => r.w, u: 'W' }, radio()] },
  purifier: { label: 'Air purifier', icon: '<rect x="6" y="3" width="12" height="18" rx="3"/><path d="M9 7h6M9 10h6M9 13h6"/>', cam: 1.6, sf: 1, er: .38,
    parts: [{ key: 'hepa', name: 'HEPA filter', shape: 'cyl', size: [.12, .25], col: 0xe2e8f0, val: r => `${r.hepa} % life left`, h: r => r.hepa < 10 ? 'watch' : 'ok', s: r => r.hepa, u: '%' },
      { key: 'fan', name: 'Fan', shape: 'cyl', size: [.1, .04], col: 0x64748b, val: r => `speed ${r.fan}`, h: () => 'ok', s: r => r.fan, u: '' },
      { key: 'pm', name: 'PM2.5 sensor', shape: 'box', size: [.04, .03, .02], col: 0x1d2433, val: r => `${r.pm} µg/m³`, h: () => 'ok', s: r => r.pm, u: 'µg/m³' },
      { key: 'pcb', name: 'Control board', shape: 'box', size: [.1, .06, .01], col: 0x1d7a4a, val: () => 'No error', h: () => 'ok', s: () => 0, u: '' }] },
};


const RANK = { ok: 0, watch: 1, fault: 2 };
const worst = a => a.reduce((x, y) => RANK[y] > RANK[x] ? y : x, 'ok');
export const health = (d, t) => { const r = read(d, t); return worst(TYPES[d.type].parts.map(p => p.h(r)).concat(r.err ? ['fault'] : [])); };

/* findings: evidence, confidence and guided steps, each step tied to a part */
export function finding(d, t) {
  if (!d) return null;
  if (state.scen === 'filter' && d.id === R.filterAc && sev(t) > .3) { const r = read(d, t); return { lvl: 'fault', title: 'Airflow blocked: air filter most likely clogged', conf: 'Inferred · there is no filter sensor, but three readings agree', ev: [`Airflow down to ${r.air.toFixed(0)} %`, `Fan at ${r.fan.toFixed(0)} % to compensate`, `Coil inlet ${r.evIn.toFixed(1)} °C, close to freezing`, `Room ${r.room.toFixed(1)} °C, set point ${r.set} °C not reached`],
    steps: [{ t: 'Switch to fan-only for 10 minutes so ice on the coil melts', p: 'coil' }, { t: 'Lift the front panel and slide out the air filter', p: 'filter' }, { t: 'Wash the filter in lukewarm water, dry it and refit', p: 'filter' }, { t: 'Check airflow and fan speed return to normal', p: 'fan' }] }; }
  if (state.scen === 'refrig' && R.far.length && (d.id === R.odu || R.far.includes(d.id)) && sev(t) > .35) { const o = oduRead(t), r = acRead(byId[R.far[R.far.length - 1]], t); return { lvl: o.dis > 100 ? 'fault' : 'watch', title: 'Refrigerant shortage: likely a leak in the circuit', conf: 'Likely · four readings agree; the leak location is not measured', ev: [`Outdoor unit discharge ${o.dis.toFixed(1)} °C (normal under 100)`, `Low pressure ${o.lp.toFixed(1)} kgf/cm² and falling`, `Far rooms (${R.farNames}): superheat ${r.sh.toFixed(1)} K`, 'Rooms nearest the outdoor unit are least affected'],
    steps: [{ t: 'Confirm low pressure on the outdoor unit gauge port', p: 'lp' }, { t: 'Check expansion valves are fully open to the far rooms', p: 'eev' }, { t: 'Leak-test joints along the pipe run to the far rooms', p: 'acc' }, { t: 'Repair, vacuum and recharge; watch discharge temperature drop', p: 'comp' }], trace: R.far[R.far.length - 1] }; }
  if (state.scen === 'washer' && d.id === R.washer && t > 14.1) return { lvl: 'fault', title: 'Washer cannot drain: drain pump blocked', conf: 'Confirmed by sensor · pump current 0 A, water level stays high, and the leak sensor next to it is wet', ev: ['Drain pump current 0 A since 14:00', 'Water level sensor: high, not draining', 'Cycle stopped with a drain error', `Leak sensor ${R.leak ?? ''} beside the washer reports water`],
    steps: [{ t: 'Switch off the washer and mop up the water around it', p: 'dlock' }, { t: 'Open the filter cap at the bottom front and drain the remaining water', p: 'pump' }, { t: 'Remove debris from the pump filter and check the impeller turns', p: 'pump' }, { t: 'Run a drain-and-spin cycle and confirm the level sensor reads empty', p: 'level' }] };
  if (state.scen === 'washer' && d.id === R.leak && read(d, t).wet) return { lvl: 'fault', title: 'Water detected beside the washer', conf: 'Confirmed by sensor · probes are wet', ev: ['Water on the floor since 14:18', 'The washer next to it stopped with a drain error at 14:06', 'Likely source: the washer, not the plumbing'], steps: [{ t: 'Dry the area and check the probes stay dry', p: 'probe' }, { t: `Open the washer to fix the cause (see ${R.washer})`, p: 'probe', go: R.washer }] };
  if (d.id === R.lowBatt) return { lvl: 'watch', title: 'Battery low: about 2 weeks left', conf: 'Confirmed by device · battery report', ev: ['Battery at 12 %', 'Motion events still arriving normally'], steps: [{ t: 'Twist off the back cover', p: 'lens' }, { t: 'Replace the CR123A battery', p: 'batt' }, { t: 'Walk past the sensor and check motion is reported', p: 'pir' }] };
  return null;
}


export { read, sev, acRead, oduRead };
export const LBL: Record<string, string> = { ok: 'Normal', watch: 'Watch', fault: 'Fault' };

/** Snapshot of one device at time t: readings, part values and health, finding. */
export function snapshot(id: string, t: number, extra: Record<string, unknown> | null = null) {
  const d = byId[id]; if (!d) return null;
  const r = { ...read(d, t), ...(extra ?? {}) }, T = TYPES[d.type];
  return {
    id: d.id, type: d.type, label: T.label, room: d.room, name: d.name, time: t,
    health: health(d, t),
    readings: r,
    parts: T.parts.map(p => ({ key: p.key, name: p.name, value: p.val(r), health: p.h(r), unit: p.u, series: +p.s(r), inferred: !!p.note })),
    finding: finding(d, t),
  };
}
/** History of one part as [time, value] pairs between t0 and t1 (hours). */
export function partHistory(id: string, key: string, t0 = 6, t1 = 22, step = 0.1) {
  const d = byId[id]; const p = TYPES[d.type].parts.find(x => x.key === key); const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) out.push([+t.toFixed(2), +p.s(read(d, t))]);
  return out;
}

if (!G.init) { setLayout(building.rooms, devices); LAYOUT.version = 0; G.init = true; }

/** Whether the current layout has the devices a scenario needs. */
export const scenarioAvailable = (key: string) => key === 'normal' || (key === 'filter' && !!R.filterAc) || (key === 'refrig' && !!R.odu && R.far.length > 0) || (key === 'washer' && !!R.washer);

/** Scenario display name, adjusted to the current layout. */
export const scenarioName = (key: string) => G.scenNames[key] ?? SCEN[key]?.name;
