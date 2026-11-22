// Energy: what every device draws right now, what each room and the floor used today, what it cost, its carbon,
// and the energy the presence-aware automation avoided.
//
// Power per device comes from, in order:
//   meter  a SmartThings powerMeter reading on the real device (watts as reported)
//   model  the device's simulated/derived readings (light level, AC load, TV on, fan speed…) through a power model
//          per device type; for the zone's real lights the model follows the real device's reported level
// Air conditioners carry their share of the outdoor unit's compressor (by their cooling load), so a room's energy
// includes its cooling; the outdoor unit itself shows only its standby draw.
//
// Integration runs on real time (not the simulator clock), sampled every 2 s by the experience loop. Today's
// totals survive a restart (.data/energy.json). "Avoided" energy: while the automation holds a room in eco (guest
// out, checked out, vacant), the difference between what the room drew before eco and what it draws now.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEV, ROOMS } from '@/lib/sim/engine';
import { device } from '@/lib/sim/runtime';
import { ST_PROFILE } from '@/lib/sim/stzone';
import { log as journal } from '@/lib/kg/journal';
import { clamp, num, round, roomName } from './geo';

export type PowerSource = 'meter' | 'model' | 'offline';
type DevE = { wh: number; w: number; src: PowerSource };
type Eco = { room: string; reason: string; since: number; baseline: Record<string, number>; avoidedWh: number };
type Tariff = { perKWh: number; currency: string; co2PerKWh: number };
type State = {
  day: string; devices: Record<string, DevE>; hours: number[]; avoidedWh: number; ecos: Record<string, Eco>;
  lastAt: number; savedAt: number; trend: { at: number; w: number }[]; tariff: Tariff; ecoLog: { at: number; room: string; reason: string; kwh: number }[];
};

const FILE = path.join(process.cwd(), '.data', 'energy.json');
const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const envTariff = (): Tariff => ({
  perKWh: num(process.env.ENERGY_TARIFF_PER_KWH, 0.15),
  currency: process.env.ENERGY_CURRENCY || 'USD',
  co2PerKWh: num(process.env.GRID_CO2_KG_PER_KWH, 0.45),
});

const g = globalThis as unknown as { __energy?: State };
const S: State = (g.__energy ??= (() => {
  const s: State = { day: dayKey(), devices: {}, hours: Array(24).fill(0), avoidedWh: 0, ecos: {}, lastAt: Date.now(), savedAt: Date.now(), trend: [], tariff: envTariff(), ecoLog: [] };
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, 'utf8'));
      if (j.day === s.day) {
        for (const [id, wh] of Object.entries(j.devices ?? {})) s.devices[id] = { wh: Number(wh) || 0, w: 0, src: 'model' };
        if (Array.isArray(j.hours) && j.hours.length === 24) s.hours = j.hours.map(Number);
        s.avoidedWh = Number(j.avoidedWh) || 0;
        s.ecoLog = Array.isArray(j.ecoLog) ? j.ecoLog.slice(-50) : [];
      }
      if (j.tariff) s.tariff = { ...s.tariff, ...j.tariff };
    }
  } catch { /* start fresh */ }
  return s;
})());

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ day: S.day, devices: Object.fromEntries(Object.entries(S.devices).map(([k, v]) => [k, round(v.wh, 3)])), hours: S.hours.map(h => round(h, 3)), avoidedWh: round(S.avoidedWh, 3), ecoLog: S.ecoLog, tariff: S.tariff }));
  } catch { /* memory only */ }
  S.savedAt = Date.now();
}

/** A new day starts from zero (yesterday's total goes to the journal). */
function rollDay() {
  const k = dayKey();
  if (k === S.day) return;
  const kwh = Object.values(S.devices).reduce((a, d) => a + d.wh, 0) / 1000;
  journal({ kind: 'energy', text: `Energy on ${S.day}: ${round(kwh, 2)} kWh used, ${round(S.avoidedWh / 1000, 2)} kWh avoided by the automation` });
  S.day = k; S.hours = Array(24).fill(0); S.avoidedWh = 0; S.ecoLog = [];
  for (const d of Object.values(S.devices)) d.wh = 0;
  for (const e of Object.values(S.ecos)) e.avoidedWh = 0;
  save();
}

// Rated draw of the zone's light fixtures relative to the simulator's 10 W bulb (an LED panel draws more than a spot).
const FIXTURE: Record<string, number> = { panel: 3.6, window: 1.4, spot: 0.6, wall: 0.9, desk: 0.8, lamp: 1.0 };

/** Watts a device draws now, and where the number comes from. */
export function powerOf(d: any, r: Record<string, any>, online = true): { w: number; src: PowerSource } {
  if (!online || r.online === false) return { w: 0, src: 'offline' };
  if (typeof r.power === 'number' && Number.isFinite(r.power)) return { w: Math.max(0, r.power), src: 'meter' };
  const model = (w: number) => ({ w: Math.max(0, w), src: 'model' as const });
  switch (d.type) {
    case 'ac': {
      if (r.on === false) return model(2);
      const fan = num(r.w, 18 + num(r.fan, 55) * 0.55);
      const mode = String(r.mode ?? 'cool'), room = num(r.room, 24), set = num(r.set, 24);
      if (mode === 'fan') return model(fan);
      if (mode === 'dry') return model(fan + 320);
      const need = mode === 'heat' ? set - room : mode === 'cool' ? room - set : Math.abs(room - set);
      // inverter compressor: modulates with the load; holds ~260 W at the set point, idles when overshot
      const comp = need < -0.5 ? 60 : clamp(260 + 320 * Math.max(0, need), 260, 1600);
      return model(fan + comp);
    }
    case 'odu': return model(60);   // controller and crankcase heater; the compressor is counted on the indoor units
    case 'light': return model(num(r.w, num(r.lv, 0) * 0.095 + 0.3) * (FIXTURE[d.fixture] ?? 1));
    case 'blinds': return model(r.moving || r.shade === 'opening' || r.shade === 'closing' ? 30 : 0.4);
    case 'plug': return model(ST_PROFILE[d.id] ? (r.on === false ? 0.3 : 1.2) : r.on === false ? 0.3 : num(r.w, 1.2));
    case 'lock': return model(0.2);
    case 'vacuum': return model(r.state === 'Cleaning' ? 42 : r.state === 'Returning' ? 35 : num(r.batt, 100) < 100 ? 22 : 1.5);
    case 'fridge': return model(r.comp === 'Running' ? 95 : 8);
    case 'temphum': case 'motion': case 'leak': return model(0.05);
    case 'doorbell': return model(2.5);
    default: return model(num(r.w, 1));
  }
}

/** One integration step: every device's power now, added to today's energy. Called by the experience loop. */
export function sample() {
  rollDay();
  const now = Date.now();
  const dt = clamp((now - S.lastAt) / 1000, 0, 10);
  S.lastAt = now;
  let total = 0;
  for (const d of DEV as any[]) {
    let p: { w: number; src: PowerSource };
    try {
      const s: any = device(d.id);
      p = s ? powerOf(d, s.readings ?? {}, s.online !== false) : { w: 0, src: 'offline' };
    } catch { p = { w: 0, src: 'offline' }; }
    const e = (S.devices[d.id] ??= { wh: 0, w: 0, src: p.src });
    e.wh += (p.w * dt) / 3600; e.w = p.w; e.src = p.src;
    total += p.w;
  }
  S.hours[new Date().getHours()] += (total * dt) / 3600;
  for (const eco of Object.values(S.ecos)) {
    const base = Object.values(eco.baseline).reduce((a, b) => a + b, 0);
    const cur = Object.keys(eco.baseline).reduce((a, id) => a + (S.devices[id]?.w ?? 0), 0);
    const wh = (Math.max(0, base - cur) * dt) / 3600;
    eco.avoidedWh += wh; S.avoidedWh += wh;
  }
  const last = S.trend[S.trend.length - 1];
  if (!last || now - last.at >= 30_000) { S.trend.push({ at: now, w: round(total, 1) }); if (S.trend.length > 240) S.trend.shift(); }
  if (now - S.savedAt > 60_000) save();
}

/** Power of each device in a room now (from the last sample). */
const roomDevices = (room: string) => (DEV as any[]).filter(d => d.room === room);

/** The automation takes a room to eco: remember what it drew so the avoided energy can be counted. */
export function startEco(room: string, reason: string) {
  if (S.ecos[room]) { S.ecos[room].reason = reason; return; }
  const baseline: Record<string, number> = {};
  for (const d of roomDevices(room)) baseline[d.id] = S.devices[d.id]?.w ?? 0;
  S.ecos[room] = { room, reason, since: Date.now(), baseline, avoidedWh: 0 };
  journal({ kind: 'energy', room, text: `${roomName(room)} set to eco (${reason}); it was drawing ${round(Object.values(baseline).reduce((a, b) => a + b, 0), 0)} W` });
}

/** The room is in use again (a guest is on the way back or changed something): eco ends. */
export function endEco(room: string, why = 'room in use again') {
  const e = S.ecos[room];
  if (!e) return null;
  delete S.ecos[room];
  const kwh = round(e.avoidedWh / 1000, 3);
  S.ecoLog.push({ at: Date.now(), room, reason: e.reason, kwh }); if (S.ecoLog.length > 50) S.ecoLog.shift();
  journal({ kind: 'energy', room, text: `${roomName(room)} left eco (${why}) after ${Math.round((Date.now() - e.since) / 60000)} min; ${kwh} kWh avoided` });
  return kwh;
}
export const ecoRooms = () => Object.keys(S.ecos);

export const tariff = () => S.tariff;
export function setTariff(t: Partial<Tariff>) {
  if (typeof t.perKWh === 'number' && t.perKWh >= 0 && t.perKWh < 100) S.tariff.perKWh = t.perKWh;
  if (typeof t.co2PerKWh === 'number' && t.co2PerKWh >= 0 && t.co2PerKWh < 5) S.tariff.co2PerKWh = t.co2PerKWh;
  if (typeof t.currency === 'string' && /^[A-Z]{3}$/.test(t.currency)) S.tariff.currency = t.currency;
  save();
  return S.tariff;
}

/** Live watts per device (for the 3D energy layer, sent with every /api/floor poll). */
export const liveWatts = (ids?: Set<string>) => Object.fromEntries(Object.entries(S.devices).filter(([id]) => !ids || ids.has(id)).map(([id, e]) => [id, round(e.w, 1)]));

/** Energy summary for the floor, or for one room (a guest sees only their own room). */
export function summary(room?: string) {
  const T = S.tariff;
  const devs = (DEV as any[]).filter(d => !room || d.room === room);
  const ids = new Set(devs.map(d => d.id));
  const w = devs.reduce((a, d) => a + (S.devices[d.id]?.w ?? 0), 0);
  const wh = devs.reduce((a, d) => a + (S.devices[d.id]?.wh ?? 0), 0);
  const ecos = Object.values(S.ecos).filter(e => !room || e.room === room);
  const avoidedWh = room ? ecos.reduce((a, e) => a + e.avoidedWh, 0) + S.ecoLog.filter(e => e.room === room).reduce((a, e) => a + e.kwh * 1000, 0) : S.avoidedWh;
  const rooms = (ROOMS as any[]).filter(r => !room || r.key === room).map(r => {
    const ds = devs.filter(d => d.room === r.key);
    return { key: r.key, name: roomName(r.key), w: round(ds.reduce((a, d) => a + (S.devices[d.id]?.w ?? 0), 0), 1), kwh: round(ds.reduce((a, d) => a + (S.devices[d.id]?.wh ?? 0), 0) / 1000, 3), devices: ds.length, eco: !!S.ecos[r.key] };
  }).filter(r => r.devices > 0).sort((a, b) => b.w - a.w);
  const top = devs.map(d => ({ id: d.id, name: String(d.name).split(' · ')[0], type: d.type, room: d.room, w: round(S.devices[d.id]?.w ?? 0, 1), kwh: round((S.devices[d.id]?.wh ?? 0) / 1000, 3), src: S.devices[d.id]?.src ?? 'model' }))
    .sort((a, b) => b.w - a.w);
  const kwh = wh / 1000, akwh = avoidedWh / 1000;
  return {
    at: Date.now(), day: S.day, scope: room ? { room, name: roomName(room) } : null,
    w: round(w, 1), kwh: round(kwh, 3), cost: round(kwh * T.perKWh, 2), co2Kg: round(kwh * T.co2PerKWh, 2),
    avoided: { kwh: round(akwh, 3), cost: round(akwh * T.perKWh, 2), co2Kg: round(akwh * T.co2PerKWh, 2) },
    tariff: T, rooms, top: top.slice(0, 8), devices: Object.fromEntries(top.map(t => [t.id, { w: t.w, kwh: t.kwh, src: t.src }])),
    eco: ecos.map(e => ({ room: e.room, name: roomName(e.room), reason: e.reason, since: e.since, kwh: round(e.avoidedWh / 1000, 3) })),
    hours: room ? null : S.hours.map(h => round(h / 1000, 3)), trend: room ? null : S.trend,
    metered: top.filter(t => t.src === 'meter').length, modelled: top.filter(t => t.src === 'model').length,
    method: 'Measured where the device reports power (SmartThings powerMeter); otherwise a per-type power model driven by the live device state. AC includes its share of the outdoor unit compressor.',
    ...(ids.size ? {} : { empty: true }),
  };
}

/** For tests: forget today's figures. */
export function resetEnergy() { S.devices = {}; S.hours = Array(24).fill(0); S.avoidedWh = 0; S.ecos = {}; S.trend = []; S.ecoLog = []; S.lastAt = Date.now(); }
