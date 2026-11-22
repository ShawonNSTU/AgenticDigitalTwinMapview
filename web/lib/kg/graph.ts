// The twin's knowledge graph, for the assistant's retrieval (RAG).
//
// Built from the live twin every time it is asked for (so it is never stale) and enriched by the journal
// (journal.ts): every action on the website after the floor plan is loaded. Two views of the same graph:
//   nodes + edges   floor -has-> room -next_to-> room, room -contains-> device / furniture, device -linked_to->
//                   SmartThings, guest -stays_in-> room, alert -on-> device, routine -uses-> device,
//                   technician -covers-> device type, event -about-> device / room
//   documents       one readable fact sheet per node (floor summary with every count, each room, each device with
//                   its live state and what it can do, each alert, guest, routine, technician) and the journal in
//                   chunks. The assistant ranks them for a question and answers only from what it retrieved.
// Everything is cut to the asker's scope: staff see the building; a guest sees the floor's public facts, their own
// room, its devices, their own routines and what happened in their room during their stay.
import { DEV, ROOMS, TYPES, LAYOUT, byId, state as engineState, scenarioName } from '@/lib/sim/engine';
import { device, rt, COMMANDS } from '@/lib/sim/runtime';
import { alerts, history, technicians } from '@/lib/sim/maintenance';
import { listPasses, entranceRooms } from '@/lib/sim/guests';
import { ROUTINES, savedFor } from '@/lib/sim/routines';
import { link, links, version as stVersion } from '@/lib/integrations/smartthings';
import { agentNames, allowedCommands, devicesInScope, ownerKey, type Scope } from '@/lib/integrations/stagent';
import { events, journalVersion, type JEvent } from './journal';
import { summary as energySummary } from '@/lib/experience/energy';
import { comfort as comfortRooms } from '@/lib/experience/comfort';
import { journeys as arrivalJourneys, housekeeping as arrivalHousekeeping } from '@/lib/experience/arrival';
import { latest as latestPredictions, dispatches as techDispatches } from '@/lib/experience/predict';

export type Doc = { id: string; kind: string; title: string; text: string; devices?: string[]; rooms?: string[] };
export type Node = { id: string; kind: string; label: string };
export type Edge = { from: string; rel: string; to: string };

const TZ = process.env.TWIN_TIMEZONE || undefined;
const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const roomOf = (key: string) => (ROOMS as any[]).find(r => r.key === key);
const roomName = (key: string) => { const r = roomOf(key); return r ? String(r.label ?? r.name).split('\n')[0] : key === 'out' ? 'Outside' : key; };
const fullName = (r: any) => (r.label && r.label !== r.name ? `${r.name} (${String(r.label).split('\n')[0]})` : r.name);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const count = <T,>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const listCounts = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');

function geometry(r: any) {
  const p: number[][] = r.poly ?? [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]];
  let a = 0; for (let i = 0; i < p.length; i++) { const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length]; a += x1 * z2 - x2 * z1; }
  return { area: Math.abs(a) / 2, w: r.x[1] - r.x[0], d: r.z[1] - r.z[0] };
}
/** Rooms that share a wall: boxes within 0.5 m on one axis and overlapping at least 0.6 m on the other. */
function neighbours(): Record<string, string[]> {
  const rs = ROOMS as any[]; const out: Record<string, string[]> = {};
  const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
  for (const a of rs) for (const b of rs) {
    if (a === b) continue;
    const ox = ov(a.x[0], a.x[1], b.x[0], b.x[1]), oz = ov(a.z[0], a.z[1], b.z[0], b.z[1]);
    if ((ox > -0.5 && ox < 0.5 && oz > 0.6) || (oz > -0.5 && oz < 0.5 && ox > 0.6)) (out[a.key] ??= []).push(b.key);
  }
  return out;
}
const inRoom = (r: any, x: number, z: number) => x >= r.x[0] && x <= r.x[1] && z >= r.z[0] && z <= r.z[1];

/** A device's live state in words. */
export function stateText(type: string, r: Record<string, any>): string {
  const on = (v: unknown) => (v === false ? 'off' : 'on');
  if (r.online === false) return 'OFFLINE (not responding)';
  switch (type) {
    case 'light': return Number(r.lv) > 0 ? `on at ${r.lv}%${r.col ? `, colour ${r.col}` : r.ct ? `, ${r.ct} K white` : ''}` : 'off';
    case 'blinds': return `${Number(r.pos) >= 99 ? 'open' : Number(r.pos) <= 1 ? 'closed' : 'partly open'} (${r.pos}% open)`;
    case 'ac': return `${on(r.on)}, mode ${r.mode ?? '?'}, set to ${r.set} °C, room ${Number(r.room).toFixed(1)} °C, fan ${r.fan}%`;
    case 'tv': return `${on(r.on)}${r.on !== false ? `, volume ${r.vol}, input ${r.input}` : ''}`;
    case 'purifier': return `${on(r.on)}, fan level ${r.fan}, PM2.5 ${r.pm} µg/m³`;
    case 'fan': return `${on(r.on)}, speed ${r.speed}${r.osc ? ', oscillating' : ''}`;
    case 'plug': return `${on(r.on)}, ${r.w} W`;
    case 'lock': return `${r.locked === false ? 'unlocked' : 'locked'}, battery ${r.batt}%`;
    case 'temphum': return `${Number(r.temp).toFixed(1)} °C, humidity ${r.hum}%`;
    case 'motion': return `${r.motion ? 'motion now' : 'no motion'}, battery ${r.batt}%`;
    case 'leak': return r.wet ? 'WET: water detected' : 'dry';
    case 'vacuum': return `${r.state}, battery ${r.batt}%`;
    case 'fridge': return `fridge ${Number(r.fz).toFixed(1)} °C, freezer ${Number(r.fr).toFixed(1)} °C, door ${r.door}`;
    case 'washer': case 'dryer': return String(r.state ?? '');
    case 'oven': return r.on ? `on, ${r.temp} °C` : 'off';
    case 'camera': return r.rec ? 'recording' : 'off';
    case 'odu': return `compressor ${Number(r.hz).toFixed(0)} Hz`;
  }
  return '';
}

function eventLine(e: JEvent) { return `${when(e.at)} · ${e.text}${e.by ? ` (by ${e.by})` : ''}`; }

/** The graph and its documents for one scope. */
export function knowledge(scope: Scope) {
  const staff = scope.kind === 'host';
  const allDevs = devicesInScope(staff ? { kind: 'host', role: scope.role } : scope);
  const names = agentNames(staff ? allDevs : devicesInScope(scope));
  const roomKeys = staff ? (ROOMS as any[]).map(r => r.key) : [scope.pass.room];
  const nb = neighbours();
  const furn = (rt.furniture ?? []) as any[];
  const al = staff ? alerts() : [];
  const passes = staff ? listPasses() : [];
  const nodes: Node[] = [{ id: 'floor', kind: 'floor', label: rt.title }];
  const edges: Edge[] = [];
  const docs: Doc[] = [];

  /* ---- devices ---- */
  const devDocs = new Map<string, Doc>();
  const recent = events();
  for (const d of allDevs) {
    const s: any = device(d.id); if (!s) continue;
    const L = link(d.id);
    const can = allowedCommands(d, scope);
    const mine = recent.filter(e => e.devices?.includes(d.id) && (staff || e.at >= scope.pass.createdAt)).slice(-4);
    const tech = staff ? technicians().find(t => t.types.includes(d.type) && (!t.rooms.length || t.rooms.includes(d.room))) : null;
    const text = [
      `${names[d.id]} (${d.id}) is a ${TYPES[d.type].label.toLowerCase()} in ${roomName(d.room)}.`,
      L ? `It is a REAL SmartThings device (SmartThings label "${L.label ?? names[d.id]}"; capabilities: ${(L.capabilities ?? []).join(', ') || 'n/a'}); its state is what the device reports.` : 'It is a simulated device (not a real SmartThings device).',
      `Now: ${stateText(d.type, s.readings) || 'no readings'}. Health: ${s.health}${s.finding ? `, problem: ${s.finding.title}` : ''}.`,
      can.length ? `It can: ${can.join(', ')}.` : COMMANDS[d.type] ? 'It can be controlled, but not by you.' : 'It is read-only (a sensor or appliance without remote control).',
      tech ? `Maintained by: ${tech.name}.` : '',
      mine.length ? `Recent: ${mine.map(eventLine).join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    const doc = { id: `device:${d.id}`, kind: 'device', title: `${names[d.id]} · ${roomName(d.room)}`, text, devices: [d.id], rooms: [d.room] };
    docs.push(doc); devDocs.set(d.id, doc);
    nodes.push({ id: `device:${d.id}`, kind: 'device', label: names[d.id] });
    edges.push({ from: `room:${d.room}`, rel: 'contains', to: `device:${d.id}` });
    if (L) edges.push({ from: `device:${d.id}`, rel: 'linked_to', to: `smartthings:${L.stId}` });
  }

  /* ---- rooms ---- */
  for (const key of roomKeys) {
    const r = roomOf(key); if (!r) continue;
    const g = geometry(r);
    const devs = allDevs.filter(d => d.room === key);
    const items = furn.filter(f => inRoom(r, f.x, f.z) && f.kind !== 'door' && f.kind !== 'column');
    const doors = furn.filter(f => f.kind === 'door' && inRoom(r, f.x, f.z)).length;
    const notes = ((rt.notes ?? []) as any[]).filter(n => inRoom(r, n.x, n.z)).map(n => n.text);
    const guests = passes.filter((p: any) => p.room === key);
    const ra = al.filter(a => a.room === key);
    const text = [
      `${fullName(r)} is a room on ${rt.title}${r.zone ? `, zone ${r.zone}` : ''}. Size about ${g.w.toFixed(1)} m × ${g.d.toFixed(1)} m (${g.area.toFixed(0)} m²).`,
      nb[key]?.length ? `Next to: ${nb[key].map(k => fullName(roomOf(k))).join(', ')}.` : '',
      devs.length ? `Devices (${devs.length}): ${devs.map(d => `${names[d.id] ?? d.id} [${stateText(d.type, (device(d.id) as any)?.readings ?? {}) || TYPES[d.type].label}]`).join('; ')}.` : 'No devices in this room.',
      items.length ? `Furniture: ${listCounts(count(items, f => String(f.kind).replace(/_/g, ' ')))}.` : '',
      doors ? `${plural(doors, 'door')}.` : '',
      notes.length ? `Printed on the plan: ${notes.slice(0, 6).join(', ')}.` : '',
      staff ? (guests.length ? `Checked-in guest(s): ${guests.map((p: any) => p.label || 'unnamed guest').join(', ')}.` : 'No guest checked in.') : '',
      staff && ra.length ? `Open alerts: ${ra.map(a => `${a.name}: ${a.title}`).join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    docs.push({ id: `room:${key}`, kind: 'room', title: fullName(r), text, rooms: [key], devices: devs.map(d => d.id) });
    nodes.push({ id: `room:${key}`, kind: 'room', label: fullName(r) });
    edges.push({ from: 'floor', rel: 'has', to: `room:${key}` });
    for (const n of nb[key] ?? []) edges.push({ from: `room:${key}`, rel: 'next_to', to: `room:${n}` });
  }

  /* ---- floor summary: every count, so "how many ..." is always answerable ---- */
  const all = ROOMS as any[];
  const typeCounts = count(allDevs, d => TYPES[d.type].label.toLowerCase());
  const real = allDevs.filter(d => link(d.id)).length;
  const health = count(allDevs, d => String((device(d.id) as any)?.health ?? 'ok'));
  const zones = count(all.filter(r => r.zone), r => `zone ${r.zone}`);
  const bigF = count(furn.filter(f => f.kind !== 'column' && f.kind !== 'door'), f => String(f.kind).replace(/_/g, ' '));
  const roomsWithDevices = [...new Set(allDevs.map(d => d.room))].map(roomName);
  const largest = [...all].map(r => ({ n: fullName(r), a: geometry(r).area })).sort((a, b) => b.a - a.a);
  const summary = staff ? [
    `Floor: ${rt.title}. Floor plan: ${rt.floor === 'upload' ? 'uploaded image' : rt.floor === 'preset' ? 'the traced 4th-floor plan' : 'none loaded yet'}.`,
    `It has ${plural(all.length, 'room')}: ${all.map(fullName).join('; ')}.`,
    Object.keys(zones).length ? `Zones: ${listCounts(zones)} rooms.` : '',
    `Largest rooms: ${largest.slice(0, 3).map(x => `${x.n} (${x.a.toFixed(0)} m²)`).join(', ')}. Total room area about ${largest.reduce((s, x) => s + x.a, 0).toFixed(0)} m².`,
    `Entrances: ${entranceRooms().map(e => e.name).join(', ') || 'none marked'}.`,
    `${plural(allDevs.length, 'device')} in total (${real} real SmartThings, ${allDevs.length - real} simulated): ${listCounts(typeCounts) || 'none'}.`,
    `Rooms with devices (${roomsWithDevices.length}): ${roomsWithDevices.join(', ') || 'none'}.`,
    `Health: ${listCounts(health)}. Open alerts: ${al.length}${al.length ? ` (${al.map(a => `${a.name} in ${a.roomName}: ${a.title}`).join('; ')})` : ''}.`,
    `Furniture on the plan: ${listCounts(bigF) || 'none'}; ${plural(furn.filter(f => f.kind === 'door').length, 'door')}.`,
    `Guests checked in: ${passes.length}${passes.length ? ` (${passes.map((p: any) => `${p.label || 'unnamed'} in ${p.roomName}`).join('; ')})` : ''}.`,
    `Routines: ${ROUTINES.length} built in, ${savedFor(ownerKey(scope)).length} saved. Simulated time ${String(Math.floor(rt.t)).padStart(2, '0')}:${String(Math.round((rt.t % 1) * 60)).padStart(2, '0')}, scenario "${scenarioName(engineState.scen)}".`,
    `${plural(events().length, 'recorded event')} since the floor plan was loaded.`,
  ] : [
    `You are staying in ${roomName(scope.pass.room)} on ${rt.title} until ${when(scope.pass.expiresAt)}.`,
    `The floor has ${plural(all.length, 'room')}: ${all.map(fullName).join('; ')}.`,
    `Entrances: ${entranceRooms().map(e => e.name).join(', ') || 'none marked'}.`,
    `Your room has ${plural(allDevs.length, 'device')}: ${listCounts(typeCounts) || 'none'}.`,
  ];
  docs.unshift({ id: 'floor:summary', kind: 'summary', title: `${rt.title}: overview`, text: summary.filter(Boolean).join(' ') });

  /* ---- alerts, guests, technicians (staff) ---- */
  if (staff) {
    for (const a of al) {
      const recs = history(a.deviceId).slice(-3);
      docs.push({ id: `alert:${a.deviceId}`, kind: 'alert', title: `Alert: ${a.name}`, devices: [a.deviceId], rooms: [a.room],
        text: `Open alert on ${a.name} (${a.deviceId}) in ${a.roomName}: ${a.title}. Level ${a.level}, status ${a.status}, since ${when(a.since)}. ${a.confidence}. Evidence: ${(a.reported ?? []).join('; ')}. Steps: ${(a.steps ?? []).map((s: any) => s.t).join('; ')}. Assigned to ${a.assignee?.name ?? 'nobody'}.${recs.length ? ` Records: ${recs.map((r: any) => `${when(r.at)} ${r.status} by ${r.by}${r.cause ? `, cause ${r.cause}` : ''}`).join('; ')}.` : ''}` });
      edges.push({ from: `alert:${a.deviceId}`, rel: 'on', to: `device:${a.deviceId}` });
    }
    for (const p of passes as any[]) {
      docs.push({ id: `guest:${p.token.slice(0, 8)}`, kind: 'guest', title: `Guest ${p.label || 'unnamed'}`, rooms: [p.room],
        text: `Guest ${p.label || '(no name)'} is checked in to ${p.roomName} from ${when(p.createdAt)} until ${when(p.expiresAt)}. ${p.pin ? 'Check-in PIN required' : 'No PIN'}. Controls allowed: ${(p.controls?.length ? p.controls : ['everything in the room']).join(', ')}; AC ${p.acRange?.join('–')} °C.` });
      edges.push({ from: `guest:${p.token.slice(0, 8)}`, rel: 'stays_in', to: `room:${p.room}` });
    }
    for (const t of technicians()) {
      docs.push({ id: `tech:${t.id}`, kind: 'technician', title: t.name, text: `${t.name} maintains: ${t.types.map(x => TYPES[x]?.label ?? x).join(', ')}${t.rooms.length ? ` in ${t.rooms.map(roomName).join(', ')}` : ' in every room'}.` });
    }
  }

  /* ---- energy, comfort, guest journeys, predicted failures (lib/experience) ---- */
  try { experienceDocs(scope, staff, docs, edges); } catch { /* the graph must build even if a service is not ready */ }

  /* ---- routines ---- */
  for (const r of ROUTINES) docs.push({ id: `routine:${r.id}`, kind: 'routine', title: `Routine ${r.name}`, text: `Built-in routine "${r.name}": ${r.about}. Runs on the devices of a chosen room.` });
  for (const r of savedFor(ownerKey(scope))) {
    const devs = [...new Set(r.steps.map(s => s.deviceId))];
    docs.push({ id: `routine:${r.id}`, kind: 'routine', title: `Routine ${r.name}`, devices: devs,
      text: `Saved routine "${r.name}" (created ${when(r.createdAt)}): ${r.steps.map(s => `${names[s.deviceId] ?? s.deviceId} ${s.command} ${Object.values(s.args).join(' ')}`.trim()).join('; ')}.` });
    for (const d of devs) edges.push({ from: `routine:${r.id}`, rel: 'uses', to: `device:${d}` });
  }

  /* ---- the journal, newest first, in chunks ---- */
  const seen = new Set(allDevs.map(d => d.id));
  const visible = recent.filter(e => staff || ((e.room === scope.pass.room || e.devices?.some(x => seen.has(x)) || e.guest === scope.pass.token) && e.at >= scope.pass.createdAt && e.kind !== 'guest'))
    .slice(-400).reverse();
  for (let i = 0; i < visible.length; i += 8) {
    const chunk = visible.slice(i, i + 8);
    docs.push({ id: `events:${i / 8}`, kind: 'history', title: `What happened ${when(chunk[chunk.length - 1].at)} – ${when(chunk[0].at)}`,
      text: chunk.map(eventLine).join('. ') + '.', devices: [...new Set(chunk.flatMap(e => e.devices ?? []))], rooms: [...new Set(chunk.map(e => e.room).filter(Boolean) as string[])] });
  }

  const ver = `${LAYOUT.version}.${LAYOUT.devVersion}.${journalVersion()}.${stVersion()}`;
  return { version: ver, scope: staff ? `staff:${scope.role}` : `guest:${scope.pass.token.slice(0, 8)}`, docs, nodes, edges,
    stats: { rooms: all.length, devices: allDevs.length, real, docs: docs.length, events: visible.length, edges: edges.length } };
}

const money = (v: number, c: string) => `${v.toFixed(2)} ${c}`;

/** Fact sheets for energy, comfort, guest journeys and predictions, cut to the asker's scope. */
function experienceDocs(scope: Scope, staff: boolean, docs: Doc[], edges: Edge[]) {
  const pass = scope.kind === 'guest' ? scope.pass : null;
  const myRoom = pass?.room;
  // energy
  const e = energySummary(myRoom);
  if (!e.empty) {
    const T = e.tariff;
    docs.push({ id: myRoom ? `energy:${myRoom}` : 'energy:floor', kind: 'energy', title: myRoom ? `Energy in ${roomName(myRoom)}` : `${rt.title}: energy today`, rooms: myRoom ? [myRoom] : e.rooms.slice(0, 6).map(r => r.key),
      text: `${myRoom ? `${roomName(myRoom)} draws` : 'The floor draws'} ${Math.round(e.w)} W right now and used ${e.kwh.toFixed(2)} kWh today (${e.day}), about ${money(e.cost, T.currency)} at ${T.perKWh} ${T.currency}/kWh and ${e.co2Kg.toFixed(2)} kg CO2 at ${T.co2PerKWh} kg/kWh. `
        + `The presence-aware automation (eco while guests are out or after checkout) avoided ${e.avoided.kwh.toFixed(3)} kWh (${money(e.avoided.cost, T.currency)}, ${e.avoided.co2Kg.toFixed(2)} kg CO2) today. `
        + (e.eco.length ? `In eco now: ${e.eco.map(x => `${x.name} (${x.reason}, ${x.kwh.toFixed(3)} kWh avoided so far)`).join('; ')}. ` : 'No room is in eco now. ')
        + `Biggest loads now: ${e.top.slice(0, 5).map(t => `${t.name} (${t.id}) ${Math.round(t.w)} W`).join(', ')}. `
        + (myRoom ? '' : `By room: ${e.rooms.slice(0, 8).map(r => `${r.name} ${Math.round(r.w)} W / ${r.kwh.toFixed(2)} kWh`).join('; ')}. `)
        + `Method: ${e.metered} device(s) measured by a power meter, ${e.modelled} from the power model of their live state.` });
  }
  // comfort
  for (const c of comfortRooms(myRoom)) {
    docs.push({ id: `comfort:${c.room}`, kind: 'comfort', title: `Comfort in ${c.name}`, rooms: [c.room],
      text: `${c.name} comfort ${c.score}/100 (${c.grade}). Temperature ${c.temp} °C against a target of ${c.target} °C (${c.parts.thermal.label}, from ${c.parts.thermal.source}); humidity ${c.hum} %; `
        + `air PM2.5 ${c.pm} (${c.parts.air.label}, ${c.parts.air.measured ? `measured by ${c.parts.air.source}` : c.parts.air.source}); light about ${c.lux} lux (${c.parts.light.label}, estimated); noise about ${c.db} dB (${c.parts.sound.label}, estimated). `
        + (c.trend != null ? `Temperature trend ${c.trend} °C/min${c.etaToTargetMin ? `, target in about ${c.etaToTargetMin} min` : ''}. ` : '')
        + (c.advice.length ? `To improve it: ${c.advice.map(a => a.text).join('; ')}.` : 'Nothing to improve right now.') });
    edges.push({ from: `comfort:${c.room}`, rel: 'of', to: `room:${c.room}` });
  }
  // guest journeys
  for (const j of arrivalJourneys().filter(j => staff || j.token === pass?.token)) {
    const id = `journey:${j.token.slice(0, 8)}`;
    docs.push({ id, kind: 'journey', title: `${staff ? `${j.guest || 'Guest'}'s` : 'Your'} arrival · ${j.roomName}`, rooms: [j.room],
      text: `${staff ? `Guest ${j.guest || '(no name)'}` : 'Your stay'} in ${j.roomName}: ${j.state.replace('_', ' ')}. `
        + (j.eta ? `Expected in about ${Math.max(0, Math.round((j.eta - Date.now()) / 60000))} min (from ${j.etaSource}). ` : '')
        + `Preferences: ${j.prefs.temp} °C, ${j.prefs.scene} light, curtain ${j.prefs.curtain} % open${j.prefs.tvWelcome ? ', welcome on the TV' : ''}. `
        + (j.steps.length ? `Welcome scene: ${j.steps.filter(s => s.status === 'done').length} of ${j.steps.length} steps done${j.steps.some(s => s.real) ? ` (${j.steps.filter(s => s.real).length} on real SmartThings devices)` : ''}${j.steps.some(s => s.status === 'failed') ? `; failed: ${j.steps.filter(s => s.status === 'failed').map(s => s.label).join(', ')}` : ''}. ` : '')
        + `Timeline: ${j.timeline.slice(-5).map(t => `${when(t.at)} ${t.text}`).join('; ')}.` });
    edges.push({ from: id, rel: 'for', to: `room:${j.room}` });
  }
  if (!staff) return;
  for (const h of arrivalHousekeeping().slice(0, 6))
    docs.push({ id: `housekeeping:${h.id}`, kind: 'housekeeping', title: `Housekeeping · ${h.roomName}`, rooms: [h.room], text: `Housekeeping for ${h.roomName} requested ${when(h.at)}: ${h.status.replace('_', ' ')}. Tasks: ${h.items.join('; ')}.` });
  // predicted failures and dispatches
  for (const p of latestPredictions()) {
    docs.push({ id: `prediction:${p.key}`, kind: 'prediction', title: `Predicted: ${p.name} · ${p.title}`, devices: [p.deviceId], rooms: [p.room],
      text: `Predicted failure on ${p.name} (${p.deviceId}) in ${p.roomName}: ${p.title}${p.etaMin != null ? `, in about ${p.etaText}` : ` (${p.etaText})`}. Basis: ${p.basis}, confidence ${Math.round(p.confidence * 100)} %. Evidence: ${p.evidence.join('; ')}. Recommended: ${p.action}.` });
    edges.push({ from: `prediction:${p.key}`, rel: 'on', to: `device:${p.deviceId}` });
  }
  for (const d of techDispatches())
    docs.push({ id: `dispatch:${d.deviceId}`, kind: 'dispatch', title: `Technician dispatch · ${d.deviceId}`, devices: [d.deviceId], text: `${d.tech?.name ?? 'A technician'} was dispatched ${when(d.at)} from ${d.fromName} to ${d.deviceId}: ${d.reason}. Status: ${d.status.replace('_', ' ')}.` });
}

/** Context for the agentic UI's empty state: counts and what needs attention. */
export function brief(scope: Scope) {
  const k = knowledge(scope);
  const staff = scope.kind === 'host';
  return { stats: k.stats, title: rt.title, empty: rt.floor === 'none',
    alerts: staff ? alerts().slice(0, 4).map(a => ({ id: a.deviceId, name: a.name, room: a.roomName, title: a.title, level: a.level })) : [],
    guests: staff ? listPasses().length : 0, routines: [...ROUTINES.map(r => r.name), ...savedFor(ownerKey(scope)).map(r => r.name)],
    real: links().length };
}
