// Experience services: power model, energy integration and eco savings, comfort scoring and advice, failure
// predictions from a degrading fault, and the arrival welcome scene. Run: npm run test:experience (exits 1 on failure)
import { DEV, ROOMS, setDevices, setFault, clearFault, byId } from '../lib/sim/engine';
import { runCommand, rt } from '../lib/sim/runtime';
import { powerOf, sample, startEco, endEco, summary, resetEnergy } from '../lib/experience/energy';
import { roomComfort, setTarget } from '../lib/experience/comfort';
import { predictions } from '../lib/experience/predict';
import { welcomeScene } from '../lib/experience/arrival';
import { humanize, checklist } from '../lib/story';
import { sheet4F } from '../lib/sim/sheet4f';
import { readFileSync } from 'node:fs';

let fails = 0, passes = 0;
const ok = (c: unknown, what: string) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---- power model ----
ok(near(powerOf({ type: 'light', fixture: 'panel' }, { lv: 100, w: 9.8 }).w, 35.3, 0.5), 'LED panel at 100 % ≈ 35 W');
ok(powerOf({ type: 'light' }, { lv: 0, w: 0.3 }).w < 0.5, 'a light that is off draws standby only');
ok(powerOf({ type: 'ac' }, { on: false }).w === 2, 'AC off: 2 W standby');
const cooling = powerOf({ type: 'ac' }, { on: true, mode: 'cool', room: 26, set: 23, w: 48 }).w;
ok(cooling > 1000 && cooling < 1700, `AC cooling 3 °C above set point draws about 1.2 kW (${cooling})`);
ok(powerOf({ type: 'ac' }, { on: true, mode: 'cool', room: 22, set: 24, w: 48 }).w < 150, 'AC overshot its set point idles');
const m = powerOf({ type: 'plug' }, { on: true, power: 61.5 });
ok(m.w === 61.5 && m.src === 'meter', 'a power meter reading wins over the model');
ok(powerOf({ type: 'tv' }, { on: true, w: 112, online: false }).src === 'offline', 'offline devices draw nothing known');

// ---- a room with the guest-room kit (in whichever floor is loaded) ----
const ROOM: string = (ROOMS as any[])[0].key;
setDevices([
  { id: 'AC-T', type: 'ac', room: ROOM, name: 'Ceiling AC', position: [0, 2.4, 0] },
  { id: 'LT-T', type: 'light', room: ROOM, name: 'Main light', position: [1, 2.6, 1] },
  { id: 'BL-T', type: 'blinds', room: ROOM, name: 'Blinds', position: [2, 1.5, 0] },
  { id: 'AP-T', type: 'purifier', room: ROOM, name: 'Purifier', position: [-1, 0, 1] },
  { id: 'TV-T', type: 'tv', room: ROOM, name: 'TV', position: [0, 1, 2] },
  { id: 'VC-T', type: 'vacuum', room: ROOM, name: 'Vacuum', position: [0, 0, -1] },
]);
ok(DEV.length === 6 && !!byId['AC-T'], 'test devices placed');

// ---- energy integration and eco ----
resetEnergy();
const realNow = Date.now;
let t0 = realNow();
Date.now = () => t0;
runCommand('AC-T', 'power', { on: 'true' });
runCommand('LT-T', 'setLevel', { percent: 100 });
sample();
t0 += 10_000; sample();      // 10 s
const s1 = summary();
ok(s1.w > 50 && s1.kwh > 0, `floor draws power and integrates energy (${s1.w} W, ${s1.kwh} kWh)`);
const wh10 = s1.kwh * 1000, expect = (s1.w * 10) / 3600;
ok(near(wh10, expect, expect * 0.25 + 0.01), `energy ≈ power × time (${wh10.toFixed(3)} Wh vs ${expect.toFixed(3)} Wh)`);
startEco(ROOM, 'test: guest out');
runCommand('AC-T', 'power', { on: 'false' });
runCommand('LT-T', 'setLevel', { percent: 0 });
runCommand('TV-T', 'power', { on: 'false' });
t0 += 1000; sample();
t0 += 60_000; sample();      // a minute in eco
const s2 = summary();
ok(s2.avoided.kwh > 0 && s2.eco.length === 1, `eco avoided energy is counted (${s2.avoided.kwh} kWh)`);
const avoided = endEco(ROOM, 'test');
ok(avoided != null && avoided > 0 && summary().eco.length === 0, 'eco ends and records what it avoided');
Date.now = realNow;

// ---- comfort ----
runCommand('AC-T', 'power', { on: 'false' });
rt.t = 14;
setTarget(ROOM, 22);
const c = roomComfort(ROOM)!;
ok(!!c && c.score >= 0 && c.score <= 100, `comfort scored (${c?.score})`);
ok(c.parts.thermal.measured && /AC|Ceiling/.test(c.parts.thermal.source), 'room temperature comes from the AC room sensor');
ok(c.temp > 22.7 ? c.advice.some(a => a.part === 'thermal' && a.actions.some(x => x.command === 'setTemperature' && (x.args as any).celsius === 22)) : true, 'warm room: advice cools it to the guest target');
ok(c.target === 22, 'target follows the guest preference');
runCommand('VC-T', 'start', {});
runCommand('TV-T', 'power', { on: 'true' }); runCommand('TV-T', 'setVolume', { percent: 80 });
const loud = roomComfort(ROOM)!;
ok(loud.db > c.db && loud.parts.sound.score < c.parts.sound.score, `noise raises dB and lowers the sound score (${c.db} → ${loud.db} dB)`);
ok(loud.advice.some(a => a.part === 'sound' && a.actions.some(x => x.id === 'VC-T' && x.command === 'dock')), 'noisy room: advice docks the vacuum');
ok(loud.sources.some(s => s.kind === 'noise'), 'noise sources are reported for the 3D field');
runCommand('VC-T', 'dock', {}); runCommand('TV-T', 'power', { on: 'false' });
runCommand('AC-T', 'setMode', { mode: 'cool' }); runCommand('AC-T', 'setTemperature', { celsius: 20 });
ok(roomComfort(ROOM)!.sources.some(s => s.kind === 'cool' && s.id === 'AC-T'), 'a cooling AC is a cool source in the field');

// ---- predictions from a degrading fault ----
const start = realNow();
Date.now = () => start;
setFault('AC-T', 'bearing', 'degrading');
Date.now = () => start + 60_000;   // one minute into a 6-minute degradation
const ps = predictions().filter(p => p.deviceId === 'AC-T' && p.basis === 'degradation-model');
ok(ps.length > 0, 'a degrading fault yields predictions');
const motor = ps.find(p => p.part === 'motor');
// motor weight 1 × severity 1: fault at 0.6 of the ramp = 3.6 min after start, 2.6 min from now
ok(!!motor && near(motor.etaMin!, 2.6, 0.15), `motor failure predicted at the right time (${motor?.etaMin} min)`);
ok(!!motor && motor.confidence > 0.5 && motor.evidence.length >= 2, 'prediction carries confidence and evidence');
Date.now = () => start + 5 * 60_000;
ok(!predictions().some(p => p.deviceId === 'AC-T' && p.part === 'motor' && p.basis === 'degradation-model'), 'once failed it is an alert, not a prediction');
Date.now = realNow;
clearFault('AC-T');

// ---- welcome scene ----
const warm = welcomeScene(ROOM, { temp: 22.5, scene: 'warm', curtain: 40, tvWelcome: true });
ok(warm.some(x => x.id === 'AC-T' && x.command === 'setTemperature' && x.args.celsius === 22.5), 'welcome sets the AC to the guest temperature');
ok(warm.some(x => x.id === 'LT-T' && x.command === 'setColorTemperature' && x.args.kelvin === 2700), 'warm scene: 2700 K light');
ok(warm.some(x => x.id === 'BL-T' && x.command === 'setPosition' && x.args.percent === 40), 'curtain to the guest preference');
ok(warm.some(x => x.id === 'TV-T' && x.command === 'setInput'), 'TV shows the welcome screen');
const off = welcomeScene(ROOM, { temp: 24, scene: 'off', curtain: 0, tvWelcome: false });
ok(!off.some(x => x.id === 'LT-T') && !off.some(x => x.id === 'TV-T'), 'lights-off scene leaves the lights and the TV alone');

// ---- story phone: what the assistant changed, in words ----
ok(humanize('setShadeLevel 100') === 'fully open' && humanize('setShadeLevel 0') === 'closed', 'curtain levels in words');
ok(humanize('on · setColor {"hue":75,"saturation":100} · setLevel 25') === 'purple, 25 %', 'a colour bulb: colour and level, "on" dropped');
ok(humanize('setCoolingSetpoint 26') === '26 °C' && humanize('off') === 'off', 'AC set point and power');
const cl = checklist([{ label: 'Light 2', summary: '10 %', ok: true }, { label: 'Light 3', summary: '10 %', ok: true }, { label: 'Aqara Roller Shade Controller', summary: 'closed', ok: true }, { label: 'Light 4', summary: 'off', ok: false }]);
ok(cl.length === 3 && cl[0].label === 'Light 2, 3' && cl[1].label === 'Curtain' && cl[2].ok === false, `checklist groups the same change and names the shade (${JSON.stringify(cl)})`);

// ---- 4th floor rooms and doors as the sheet draws them ----
{
  const pre = JSON.parse(readFileSync(new URL('../lib/presets/samsung-rnd-4f.json', import.meta.url), 'utf8'));
  const { rooms, furniture, applied } = sheet4F(pre.rooms, pre.furniture);
  const doors = furniture.filter((f: any) => f.kind === 'door');
  const at = (x: number, y: number) => doors.some((d: any) => Math.abs(d.fx - x) < 0.006 && Math.abs(d.fy - y) < 0.006);
  const room = (n: string) => rooms.find((r: any) => r.name === n);
  ok(applied && !!room('Zone B Lobby') && !!room('Lift Lobby') && !!room('Zone D North Passage') && !room('Service Passage'), 'rooms the sheet draws (lobbies, passages round the lifts)');
  ok(at(0.23679, 0.2385) && !at(0.23316, 0.22286), 'gym entered from its lobby (east wall), not from the small cafeteria');
  ok(at(0.25, 0.22286) && !at(0.26684, 0.21429), 'small cafeteria opens onto the gym lobby');
  ok(at(0.626, 0.64643) && at(0.626, 0.76071) && at(0.61625, 0.68643) && !at(0.63575, 0.63214), 'experience zone and medical room through their lobby');
  ok(at(0.8245, 0.74643) && at(0.82383, 0.605) && at(0.682, 0.67857), 'male toilet from the corridor, core stair from the toilet passage, utility from the west passage');
  ok(at(0.6735, 0.092) && at(0.67047, 0.2982) && doors.some((d: any) => d.opening && Math.abs(d.fx - 0.62435) < 0.001), 'ablution door, hand-washing area open to the cafeteria and double door to Zone D');
  ok(at(0.8, 0.8268) && at(0.7499, 0.79286), 'hub room door in its north wall; store room door at the east end');
  const n = doors.length;
  sheet4F(rooms, furniture);
  ok(furniture.filter((f: any) => f.kind === 'door').length === n && rooms.length === pre.rooms.length, 'applying it again changes nothing');
}

console.log(`experience checks: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
