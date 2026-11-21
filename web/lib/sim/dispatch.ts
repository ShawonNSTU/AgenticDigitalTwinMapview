// The device integration layer: every command from the host, a guest, the AI agents or the access policy goes
// through dispatch(). A device linked to SmartThings gets the real command (and the twin shows the new state
// at once, then the device's reported status); any other device runs on the simulator.
import { byId } from './engine';
import { runCommand, rt, COMMANDS, device } from './runtime';
import { REQUIRES } from './stzone';
import * as ST from '@/lib/integrations/smartthings';
import { audit, scheduleRelock } from './access';

export type Result = { ok: boolean; error?: string; offline?: boolean; needsConfirmation?: boolean; via?: 'smartthings' | 'simulator'; device?: unknown; note?: string };

export async function dispatch(id: string, command: string, args: Record<string, unknown> = {}, confirmed = false, by = 'user'): Promise<Result> {
  const d = byId[id];
  if (!d) return { ok: false, error: `Unknown device ${id}` };
  const linked = ST.link(id);
  if (linked && COMMANDS[d.type]?.[command] && !ST.supported(id, d.type, [{ name: command, args: COMMANDS[d.type][command].args ?? {} }]).length)
    return { ok: false, error: `${linked.label ?? 'This device'} does not support "${command}"`, via: 'smartthings' };
  // the simulator checks the command, its arguments, confirmation and the offline state, and keeps the twin's
  // state; a real device is then told as well (if the real call fails, the twin goes back)
  // a device that needs another one on first (the zone's curtain motor and its blinds switch): switch it on
  let note = '';
  const need = REQUIRES[id];
  if (need && byId[need] && !(command === 'power' && String(args.on) === 'false')) {
    const sw = device(need) as any;
    if (sw && sw.readings?.on !== true) {
      const r = await dispatch(need, 'power', { on: 'true' }, false, by);
      if (!r.ok) return { ok: false, error: `${String(byId[need].name).split(' · ')[0]} could not be turned on: ${r.error}`, via: r.via };
      note = `${String(byId[need].name).split(' · ')[0]} turned on first`;
    }
  }
  const before = rt.overrides[id] ? { ...rt.overrides[id] } : undefined;
  const sim: Result = runCommand(id, command, args, confirmed, by) as Result;
  let res: Result = { ...sim, via: 'simulator' };
  if (sim.ok && linked) {
    const expect = COMMANDS[d.type]?.[command]?.apply(args, rt.overrides[id] ?? {}) ?? undefined;
    try { await ST.send(id, d.type, command, args, expect); res = { ...sim, via: 'smartthings' }; }
    catch (e) {
      if (before) rt.overrides[id] = before; else delete rt.overrides[id];
      res = { ok: false, error: (e as Error).message, via: 'smartthings' };
    }
  }
  if (d.type === 'lock' && (command === 'lock' || command === 'unlock')) {
    audit({ deviceId: id, room: d.room, action: by === 'auto-relock' ? 'relock' : command, by, ok: res.ok, reason: res.ok ? '' : res.error ?? 'refused', via: res.via ?? 'simulator' });
    if (res.ok && command === 'unlock') scheduleRelock(id, async () => (await dispatch(id, 'lock', {}, false, 'auto-relock')).ok);
  }
  return note && res.ok ? { ...res, note } : res;
}
