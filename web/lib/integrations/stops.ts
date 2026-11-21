// What the assistant may do beyond devices, through the twin (POST /api/st/v1/twin/ops/{op}):
// 3D view and simulation, guest check-in, routines, alerts and their resolution, the building's layout.
// Staff sessions (administrator, technician) get every op; a guest session only `routines` and `routine_run`,
// limited to the guest's room and pass. Every op validates its input here; the model only proposes.
import { DEV, ROOMS, TYPES, byId, clearFault, faultCatalog, setFault } from '@/lib/sim/engine';
import { COMMANDS, buildingState, device, setSim, simState } from '@/lib/sim/runtime';
import { dispatch } from '@/lib/sim/dispatch';
import { alerts, addRecord } from '@/lib/sim/maintenance';
import { createPass, listPasses, revoke, entranceRooms, guestCommand, guestCommands } from '@/lib/sim/guests';
import { ROUTINES, routineById, savedFor, savedById, saveRoutine, deleteRoutine, type SavedStep } from '@/lib/sim/routines';
import { supported } from './smartthings';
import { devicesInScope, agentNames, allowedCommands, toTwin, ownerKey, resolveDevice, type Scope, type StCmd } from './stagent';

type Out = { status: number; body: unknown };
const ok = (body: unknown): Out => ({ status: 200, body });
const bad = (status: number, error: string): Out => ({ status, body: { error } });
const roomLabel = (key: string) => { const r = (ROOMS as any[]).find(x => x.key === key); return r ? String(r.label ?? r.name).split('\n')[0] : key; };
const GUEST_OPS = new Set(['routines', 'routine_run', 'routine_save', 'routine_delete']);

export async function runOp(op: string, b: Record<string, any>, scope: Scope): Promise<Out> {
  const staff = scope.kind === 'host';
  if (!staff && !GUEST_OPS.has(op)) return bad(403, 'Not available to guests');
  const by = staff ? `assistant (${scope.role})` : 'assistant (guest)';

  switch (op) {
    case 'layout': {
      const bs: any = buildingState();
      const rooms = (bs.rooms as any[]).map(r => {
        const devs = (DEV as any[]).filter(d => d.room === r.key);
        const types: Record<string, number> = {};
        for (const d of devs) types[TYPES[d.type].label] = (types[TYPES[d.type].label] ?? 0) + 1;
        return { id: r.key, name: roomLabel(r.key), devices: devs.length, types };
      });
      return ok({ title: bs.title, has_floor_plan_image: !!bs.plan, floor_loaded: !bs.empty, room_count: rooms.length, device_count: bs.devices.length,
        rooms, entrances: entranceRooms().map(e => e.name), furniture_items: (bs.furniture ?? []).length });
    }
    case 'alerts': {
      const list = alerts().map(a => ({ device_id: a.deviceId, name: a.name, room: a.roomName, level: a.level, title: a.title, minutes: Math.round((Date.now() - a.since) / 60000),
        status: a.status, assignee: a.assignee?.name ?? null, first_step: a.steps?.[0]?.t ?? null, simulated_fault: a.simulated }));
      return ok({ alerts: list });
    }
    case 'alert_update': {
      if (!byId[b.device_id]) return bad(404, `Unknown device ${b.device_id}`);
      if (!['acknowledged', 'investigating', 'resolved'].includes(b.status)) return bad(422, 'status must be acknowledged, investigating or resolved');
      try { const r = addRecord({ deviceId: b.device_id, status: b.status, cause: b.cause, action: b.action, notes: b.notes, by, alert: b.alert }); return ok({ ok: true, record: r }); }
      catch (e) { return bad(400, (e as Error).message); }
    }
    case 'faults': {
      const d = byId[b.device_id]; if (!d) return bad(404, `Unknown device ${b.device_id}`);
      return ok({ device_id: d.id, faults: faultCatalog(d.type).map((f: any) => ({ key: f.key, name: f.name, what: f.what })), active: (device(d.id) as any)?.fault ?? null });
    }
    case 'clear_fault': {
      if (!byId[b.device_id]) return bad(404, `Unknown device ${b.device_id}`);
      const r = clearFault(b.device_id);
      if (r.ok) addRecord({ deviceId: b.device_id, status: 'resolved', cause: String(b.cause ?? ''), action: String(b.action ?? 'Fault cleared'), by });
      return ok({ ok: r.ok, note: r.ok ? 'fault cleared; the device returns to normal' : 'that device has no simulated fault' });
    }
    case 'simulate_fault': {
      const r = setFault(b.device_id, String(b.key), ['early', 'developing', 'severe'].includes(b.level) ? b.level : 'developing');
      return r.ok ? ok({ ok: true }) : bad(400, String((r as any).error ?? 'could not start that fault'));
    }
    case 'sim': {
      const s = setSim({ ...(b.scenario ? { scenario: String(b.scenario) } : {}), ...(typeof b.time === 'number' ? { t: b.time } : {}) });
      return ok({ time: s.t, scenario: s.scenario, scenarios: (s as any).scenarios });
    }
    case 'passes': return ok({ passes: listPasses(b.room).map((p: any) => ({ token: p.token, room: p.room, room_name: p.roomName, label: p.label, expires_at: p.expiresAt, verify: !!p.pin })) });
    case 'pass_create': {
      try {
        const hours = Math.max(0.25, Math.min(24 * 31, Number(b.hours) || 24));
        const p: any = createPass(String(b.room), hours, '', String(b.label ?? ''), { verify: b.verify !== false });
        return ok({ token: p.token, path: `/guest/${p.token}`, room: p.room, room_name: p.roomName, pin: p.pin || null, expires_at: p.expiresAt, label: p.label });
      } catch (e) { return bad(400, (e as Error).message); }
    }
    case 'pass_revoke': return revoke(String(b.token)) ? ok({ ok: true }) : bad(404, 'No such guest pass');
    case 'routines': return ok({ routines: [...ROUTINES.map(r => ({ id: r.id, name: r.name, about: r.about })), ...savedFor(ownerKey(scope)).map(r => ({ id: r.id, name: r.name, about: `your routine: ${r.steps.length} step(s) on ${new Set(r.steps.map(x => x.deviceId)).size} device(s)`, custom: true }))], rooms: staff ? [...new Set(devicesInScope(scope).map(d => d.room))].map(k => ({ id: k, name: roomLabel(k) })) : undefined });
    case 'routine_save': return saveFromActions(String(b.name ?? ''), Array.isArray(b.actions) ? b.actions : [], scope);
    case 'routine_delete': return deleteRoutine(ownerKey(scope), String(b.routine)) ? ok({ ok: true }) : bad(404, 'No such saved routine');
    case 'routine_run': if (String(b.routine).startsWith('c-')) return runSaved(String(b.routine), scope, by); return runRoutine(String(b.routine), staff ? String(b.room ?? '') : scope.pass.room, scope, by);
  }
  return bad(404, `Unknown op ${op}`);
}

/** Run a routine on a room's devices. Skips what a device can't do; reports every device. */
async function runRoutine(id: string, room: string, scope: Scope, by: string): Promise<Out> {
  const r = routineById(id);
  if (!r) return bad(404, `Unknown routine ${id}`);
  if (!room || !(ROOMS as any[]).some(x => x.key === room)) return bad(422, 'Say which room');
  const devs = devicesInScope(scope).filter(d => d.room === room);
  const names = agentNames(devs);
  const results: { device_id: string; name: string; steps: string[]; ok: boolean; error?: string }[] = [];
  for (const d of devs) {
    const steps = r.steps[d.type]; if (!steps?.length) continue;
    const allowed = scope.kind === 'guest'
      ? new Set(guestCommands(d.type, scope.pass, d.id, true).filter((c: any) => !c.confirm).map((c: any) => c.name))
      : new Set(supported(d.id, d.type, Object.entries(COMMANDS[d.type] ?? {}).filter(([, c]) => !c.confirm).map(([name, c]) => ({ name, args: (c.args ?? {}) as Record<string, any> }))).map((c: any) => c.name));
    const run = steps.filter(s => allowed.has(s.command));
    if (!run.length) continue;
    let fail = '';
    for (const s of run) {
      const res: any = scope.kind === 'guest' ? await guestCommand(scope.pass, d.id, s.command, s.args ?? {}) : await dispatch(d.id, s.command, s.args ?? {}, false, by);
      const good = 'body' in res ? res.status === 200 : res.ok;
      if (!good) { fail = 'body' in res ? String(res.body.error ?? 'refused') : String(res.error ?? 'refused'); break; }
    }
    results.push({ device_id: d.id, name: names[d.id], steps: run.map(s => s.command), ok: !fail, ...(fail ? { error: fail } : {}) });
  }
  if (!results.length) return ok({ routine: r.name, room: roomLabel(room), results, note: 'This room has no devices this routine can use.' });
  return ok({ routine: r.name, room: roomLabel(room), results });
}

/** Save what the assistant just did (device ids + SmartThings commands) as a named routine. Every command is
 *  checked again: the device is in scope and the command is one this role may run. */
function saveFromActions(name: string, actions: { device_id: string; commands: StCmd[] }[], scope: Scope): Out {
  const steps: SavedStep[] = [];
  for (const a of actions) {
    const d = resolveDevice(String(a.device_id), scope);
    if (!d) return bad(422, `${a.device_id} is not available to you`);
    const allowed = new Set(allowedCommands(d, scope));
    for (const c of Array.isArray(a.commands) ? a.commands : []) {
      const t = toTwin(d, c);
      if ('error' in t || !allowed.has(t.name)) return bad(422, `${d.id}: ${'error' in t ? t.error : `"${t.name}" is not allowed here`}`);
      steps.push({ deviceId: d.id, command: t.name, args: t.args });
    }
  }
  try { const r = saveRoutine(ownerKey(scope), name, steps); return ok({ ok: true, id: r.id, name: r.name, steps: r.steps.length, devices: new Set(r.steps.map(s => s.deviceId)).size }); }
  catch (e) { return bad(422, (e as Error).message); }
}

/** Run a saved routine: its steps in order on their own devices, with today's rules (offline, permissions). */
async function runSaved(id: string, scope: Scope, by: string): Promise<Out> {
  const r = savedById(ownerKey(scope), id);
  if (!r) return bad(404, 'No such saved routine');
  const devs = devicesInScope(scope);
  const names = agentNames(devs);
  const per = new Map<string, { device_id: string; name: string; steps: string[]; ok: boolean; error?: string }>();
  for (const s of r.steps) {
    const d = resolveDevice(s.deviceId, scope);
    const row = per.get(s.deviceId) ?? { device_id: s.deviceId, name: d ? names[d.id] ?? s.deviceId : s.deviceId, steps: [], ok: true };
    per.set(s.deviceId, row);
    if (!row.ok) continue;                                    // a device that failed gets no more steps
    if (!d) { row.ok = false; row.error = 'not available any more'; continue; }
    const res: any = scope.kind === 'guest' ? await guestCommand(scope.pass, d.id, s.command, s.args) : await dispatch(d.id, s.command, s.args, false, by);
    const good = 'body' in res ? res.status === 200 : res.ok;
    if (good) row.steps.push(s.command); else { row.ok = false; row.error = 'body' in res ? String(res.body.error ?? 'refused') : String(res.error ?? 'refused'); }
  }
  return ok({ routine: r.name, room: '', results: [...per.values()] });
}
