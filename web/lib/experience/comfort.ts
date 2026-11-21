// Comfort: how each room feels right now, from what its devices measure and do. Four parts, each scored 0-100:
//   thermal  room temperature against the occupant's target (the guest's preference, else 23 °C), humidity band
//   air      PM2.5 from the air purifier (or an assumed indoor background when no device measures it)
//   light    illuminance estimated from the lights' output and the daylight let in by blinds, against what suits the
//            time of day
//   sound    noise estimated from what is running (AC fan, fan, TV volume, vacuum, purifier), summed in dB
// The overall score weights them 40/25/20/15. Every value says whether it is measured or estimated, and each room
// gets concrete advice: device commands that would raise the score (the assistant and the "Make it comfortable"
// button run them). `sources` say where in the room it is cooler, warmer, cleaner or brighter, for the 3D field.
import { DEV, ROOMS } from '@/lib/sim/engine';
import { device } from '@/lib/sim/runtime';
import { rt } from '@/lib/sim/runtime';
import { ST_PROFILE } from '@/lib/sim/stzone';
import { area, clamp, devName, num, posOf, round, roomName } from './geo';

export type Action = { id: string; command: string; args?: Record<string, unknown> };
export type Advice = { text: string; part: 'thermal' | 'air' | 'light' | 'sound'; gain: number; actions: Action[] };
export type Source = { kind: 'cool' | 'warm' | 'clean' | 'daylight' | 'light' | 'noise'; id: string; x: number; z: number; strength: number };
export type Part = { score: number; label: string; measured: boolean; source: string };
export type RoomComfort = {
  room: string; name: string; temp: number; hum: number; pm: number; lux: number; db: number; target: number;
  score: number; grade: 'excellent' | 'good' | 'fair' | 'poor';
  parts: { thermal: Part; air: Part; light: Part; sound: Part };
  advice: Advice[]; sources: Source[]; trend: number | null; etaToTargetMin: number | null;
};

const g = globalThis as unknown as { __comfort?: { targets: Record<string, number>; history: Record<string, { at: number; temp: number }[]> } };
const C = (g.__comfort ??= { targets: {}, history: {} });

/** The occupant's preferred temperature for a room (set by the arrival journey from the guest's preferences). */
export function setTarget(room: string, celsius: number | null) { if (celsius == null) delete C.targets[room]; else C.targets[room] = clamp(celsius, 16, 30); }
export const targetOf = (room: string) => C.targets[room] ?? 23;

/** Daylight outside, 0..1, by the simulator's clock (the floor's day runs on it). */
const daylight = (t = rt.t) => clamp(Math.sin(((t - 6) / 12) * Math.PI), 0, 1);

const sumDb = (levels: number[]) => 10 * Math.log10(levels.reduce((a, l) => a + 10 ** (l / 10), 0));

function grade(s: number): RoomComfort['grade'] { return s >= 85 ? 'excellent' : s >= 70 ? 'good' : s >= 50 ? 'fair' : 'poor'; }

/** Comfort of one room now. null when the room has no devices that say anything about it. */
export function roomComfort(room: string): RoomComfort | null {
  const r = (ROOMS as any[]).find(x => x.key === room);
  if (!r) return null;
  const devs = (DEV as any[]).filter(d => d.room === room);
  if (!devs.length) return null;
  const snap = (id: string) => { try { return device(id) as any; } catch { return null; } };
  const S = devs.map(d => ({ d, s: snap(d.id) })).filter(x => x.s && x.s.online !== false);
  const of = (type: string) => S.filter(x => x.d.type === type);
  const ac = of('ac')[0], th = of('temphum')[0], pur = of('purifier')[0];
  const target = targetOf(room);
  const t = rt.t;

  // temperature: a real sensor, else the AC's room sensor (it follows the AC's commands), else the sensor, else a default
  let temp = 25, tSrc = 'estimated', tMeasured = false;
  if (th && th.s.source === 'smartthings') { temp = num(th.s.readings.temp, temp); tSrc = `${devName(th.d.id)} (real sensor)`; tMeasured = true; }
  else if (ac) { temp = num(ac.s.readings.room, temp); tSrc = `${devName(ac.d.id)} room sensor`; tMeasured = true; }
  else if (th) { temp = num(th.s.readings.temp, temp); tSrc = devName(th.d.id); tMeasured = true; }
  let hum = 55, hMeasured = false;
  if (th) { hum = num(th.s.readings.hum, hum); hMeasured = true; } else if (ac) { hum = num(ac.s.readings.hum, hum); hMeasured = true; }
  let pm = 12, pSrc = 'assumed indoor background', pMeasured = false;
  if (pur) { pm = num(pur.s.readings.pm, pm); pSrc = devName(pur.d.id); pMeasured = true; }

  // light: lumens of every light (fixture-scaled) over the floor, plus daylight through open blinds/shades
  const a = Math.max(4, area(r));
  let lumens = 0;
  const sources: Source[] = [];
  for (const { d, s } of of('light')) {
    const lv = num(s.readings.lv, 0);
    const lm = lv * 8.6 * ({ panel: 3.6, window: 1.2, spot: 0.5, wall: 0.8, desk: 0.6, lamp: 0.9 } as Record<string, number>)[d.fixture ?? ''] || lv * 8.6;
    lumens += lm;
    if (lv > 0) { const [x, z] = posOf(d.id); sources.push({ kind: 'light', id: d.id, x, z, strength: round(clamp(lv / 100, 0, 1), 2) }); }
  }
  let day = 0;
  for (const { d, s } of of('blinds')) {
    const open = num(s.readings.pos, 0) / 100;
    day = Math.max(day, open * daylight(t));
    if (open * daylight(t) > 0.05) { const [x, z] = posOf(d.id); sources.push({ kind: 'daylight', id: d.id, x, z, strength: round(open * daylight(t), 2) }); }
  }
  const lux = round(lumens * 0.55 / a + day * 320, 0);

  // sound: what is running, summed
  const levels = [30];
  for (const { d, s } of S) {
    const R = s.readings;
    if (d.type === 'ac' && R.on !== false) levels.push(26 + num(R.fan, 50) * 0.18);
    if (d.type === 'fan' && R.on) levels.push([0, 38, 44, 50][num(R.speed, 2)] ?? 44);
    if (d.type === 'tv' && R.on) levels.push(34 + num(R.vol, 20) * 0.35);
    if (d.type === 'vacuum' && R.state === 'Cleaning') levels.push(62);
    if (d.type === 'purifier' && R.on !== false) levels.push(22 + num(R.fan, 2) * 5);
    if (d.type === 'washer' && /Wash/.test(String(R.state))) levels.push(55);
  }
  const db = round(sumDb(levels), 0);

  // thermal sources for the 3D field
  if (ac && ac.s.readings.on !== false) {
    const R = ac.s.readings, mode = String(R.mode ?? 'cool'), room0 = num(R.room, temp), set = num(R.set, 24);
    const cooling = mode === 'cool' || mode === 'dry' || (mode === 'auto' && room0 > set);
    const heating = mode === 'heat' || (mode === 'auto' && room0 < set);
    const [x, z] = posOf(ac.d.id);
    if (cooling) sources.push({ kind: 'cool', id: ac.d.id, x, z, strength: round(clamp(0.35 + (room0 - set) / 4, 0.25, 1), 2) });
    else if (heating) sources.push({ kind: 'warm', id: ac.d.id, x, z, strength: round(clamp(0.35 + (set - room0) / 4, 0.25, 1), 2) });
  }
  for (const s of sources.filter(x => x.kind === 'daylight')) sources.push({ ...s, kind: 'warm', strength: round(s.strength * 0.5, 2) });
  if (pur && pur.s.readings.on !== false) { const [x, z] = posOf(pur.d.id); sources.push({ kind: 'clean', id: pur.d.id, x, z, strength: round(clamp(num(pur.s.readings.fan, 2) / 5, 0.2, 1), 2) }); }
  for (const { d, s } of S) if ((d.type === 'vacuum' && s.readings.state === 'Cleaning') || (d.type === 'tv' && s.readings.on && num(s.readings.vol, 0) > 40)) { const [x, z] = posOf(d.id); sources.push({ kind: 'noise', id: d.id, x, z, strength: 0.7 }); }

  // scores
  const dev = Math.abs(temp - target);
  let th0 = dev <= 0.5 ? 100 : Math.max(0, 100 - (dev - 0.5) * 22);
  if (hum < 30) th0 -= (30 - hum) * 0.8; if (hum > 65) th0 -= (hum - 65) * 0.8;
  const thermal = clamp(Math.round(th0), 0, 100);
  const air = clamp(Math.round(pm <= 12 ? 100 : pm <= 35 ? 100 - (pm - 12) * 1.7 : pm <= 55 ? 61 - (pm - 35) * 1.5 : 20), 0, 100);
  const night = t >= 21 || t < 6.5;
  const [lo, hi] = night ? [20, 200] : [150, 600];
  const light = clamp(Math.round(lux < lo ? 100 * (lux / lo) ** 0.6 : lux > hi ? 100 - ((lux - hi) / hi) * 60 : 100), 0, 100);
  const sound = clamp(Math.round(db <= 35 ? 100 : db <= 45 ? 100 - (db - 35) * 3 : 70 - (db - 45) * 3), 0, 100);
  const score = Math.round(0.4 * thermal + 0.25 * air + 0.2 * light + 0.15 * sound);

  const tLabel = dev <= 0.5 ? 'Just right' : temp > target ? (dev > 2 ? 'Warm' : 'Slightly warm') : dev > 2 ? 'Cool' : 'Slightly cool';
  const aLabel = pm <= 12 ? 'Clean' : pm <= 35 ? 'Moderate' : 'Poor';
  const lLabel = lux < lo ? 'Dim' : lux > hi ? 'Very bright' : night ? 'Soft' : 'Bright';
  const sLabel = db <= 35 ? 'Quiet' : db <= 45 ? 'Some noise' : 'Noisy';

  // advice: device commands that would make the room more comfortable (most gain first)
  const advice: Advice[] = [];
  if (dev > 0.7 && ac) {
    const acts: Action[] = [];
    if (ac.s.readings.on === false) acts.push({ id: ac.d.id, command: 'power', args: { on: 'true' } });
    if (num(ac.s.readings.set, 24) !== target) acts.push({ id: ac.d.id, command: 'setTemperature', args: { celsius: target } });
    const mode = temp > target ? 'cool' : 'heat';
    if (String(ac.s.readings.mode ?? 'cool') !== mode && String(ac.s.readings.mode) !== 'auto') acts.push({ id: ac.d.id, command: 'setMode', args: { mode } });
    if (acts.length) advice.push({ text: `${temp > target ? 'Cool' : 'Warm'} the room to ${target} °C with ${devName(ac.d.id)}`, part: 'thermal', gain: 100 - thermal, actions: acts });
  }
  if (pm > 15 && pur) advice.push({ text: `Run ${devName(pur.d.id)} faster to clean the air (PM2.5 ${round(pm, 0)})`, part: 'air', gain: 100 - air, actions: [...(pur.s.readings.on === false ? [{ id: pur.d.id, command: 'power', args: { on: 'true' } }] : []), { id: pur.d.id, command: 'setFan', args: { level: pm > 35 ? 5 : 4 } }] });
  if (light < 70 && lux < lo) {
    const blinds = of('blinds').filter(x => num(x.s.readings.pos, 0) < 90 && daylight(t) > 0.3);
    const acts: Action[] = blinds.map(x => ({ id: x.d.id, command: 'setPosition', args: { percent: 100 } }));
    if (!acts.length) {
      const lights = of('light').filter(x => num(x.s.readings.lv, 0) < 50 && !/window/i.test(devName(x.d.id))).slice(0, 3);
      for (const x of lights) acts.push(ST_PROFILE[x.d.id]?.kind === 'switch' ? { id: x.d.id, command: 'power', args: { on: 'true' } } : { id: x.d.id, command: 'setLevel', args: { percent: night ? 35 : 70 } });
    }
    if (acts.length) advice.push({ text: blinds.length ? 'Open the blinds to let daylight in' : 'Turn up the lights', part: 'light', gain: 100 - light, actions: acts });
  }
  if (light < 70 && lux > hi && night) {
    const acts: Action[] = of('light').filter(x => num(x.s.readings.lv, 0) > 40 && ST_PROFILE[x.d.id]?.kind !== 'switch').slice(0, 4).map(x => ({ id: x.d.id, command: 'setLevel', args: { percent: 30 } }));
    if (acts.length) advice.push({ text: 'Dim the lights for the evening', part: 'light', gain: 100 - light, actions: acts });
  }
  if (sound < 70) {
    const acts: Action[] = [];
    for (const { d, s } of S) {
      if (d.type === 'vacuum' && s.readings.state === 'Cleaning') acts.push({ id: d.id, command: 'dock' });
      if (d.type === 'tv' && s.readings.on && num(s.readings.vol, 0) > 30) acts.push({ id: d.id, command: 'setVolume', args: { percent: 20 } });
      if (d.type === 'fan' && s.readings.on && num(s.readings.speed, 1) > 1) acts.push({ id: d.id, command: 'setSpeed', args: { level: 1 } });
    }
    if (acts.length) advice.push({ text: 'Quieten what is running', part: 'sound', gain: 100 - sound, actions: acts });
  }
  advice.sort((x, y) => y.gain - x.gain);

  // temperature trend (°C per minute) and when the target will be reached
  const h = (C.history[room] ??= []);
  const now = Date.now();
  if (!h.length || now - h[h.length - 1].at > 4000) { h.push({ at: now, temp }); if (h.length > 90) h.shift(); }
  const recent = h.filter(x => now - x.at < 120_000);
  let trend: number | null = null, eta: number | null = null;
  if (recent.length >= 3) {
    const n = recent.length, mx = recent.reduce((s, x) => s + x.at, 0) / n, my = recent.reduce((s, x) => s + x.temp, 0) / n;
    const sxx = recent.reduce((s, x) => s + (x.at - mx) ** 2, 0);
    if (sxx > 0) trend = round((recent.reduce((s, x) => s + (x.at - mx) * (x.temp - my), 0) / sxx) * 60_000, 3);
    if (trend && Math.abs(trend) > 0.005 && dev > 0.5 && Math.sign(target - temp) === Math.sign(trend)) eta = round(Math.abs((temp - target) / trend), 1);
  }
  if (dev <= 0.5) eta = 0;

  return {
    room, name: roomName(room), temp: round(temp, 1), hum: round(hum, 0), pm: round(pm, 0), lux, db, target,
    score, grade: grade(score),
    parts: {
      thermal: { score: thermal, label: tLabel, measured: tMeasured && hMeasured, source: tSrc },
      air: { score: air, label: aLabel, measured: pMeasured, source: pSrc },
      light: { score: light, label: lLabel, measured: false, source: 'estimated from the lights and blinds' },
      sound: { score: sound, label: sLabel, measured: false, source: 'estimated from what is running' },
    },
    advice, sources, trend, etaToTargetMin: eta,
  };
}

/** Comfort of every room that has devices (or one room). */
export function comfort(room?: string): RoomComfort[] {
  const keys = room ? [room] : [...new Set((DEV as any[]).map(d => d.room))].filter(k => k && k !== 'out');
  return keys.map(roomComfort).filter((x): x is RoomComfort => !!x);
}

/** Compact per-room values for the 3D view (sent with every /api/floor poll). */
export function comfortField(room?: string) {
  return Object.fromEntries(comfort(room).map(c => [c.room, { temp: c.temp, hum: c.hum, pm: c.pm, lux: c.lux, db: c.db, target: c.target, score: c.score, grade: c.grade, sources: c.sources }]));
}
