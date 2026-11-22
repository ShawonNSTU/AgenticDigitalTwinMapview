// The device integration layer: every command from the host, a guest, the AI agents or the access policy goes
// through dispatch(). A device linked to SmartThings gets the real command (and the twin shows the new state
// at once, then the device's reported status); any other device runs on the simulator.
import { byId } from './engine';
import { runCommand, rt, COMMANDS, device } from './runtime';
import { REQUIRES } from './stzone';
import * as ST from '@/lib/integrations/smartthings';
import { audit, scheduleRelock } from './access';
import { log as journal } from '@/lib/kg/journal';

/** Listeners told when a person (not the automation) changed a device: room, device, who. */
type Activity = (room: string, id: string, by: string) => void;
const ga = globalThis as unknown as { __activity?: Activity[] };
const listeners: Activity[] = (ga.__activity ??= []);
export function onActivity(fn: Activity) { if (!listeners.includes(fn)) listeners.push(fn); }
/** Who acts for the building itself (their commands are not someone using the room). */
export const AUTOMATION = ['arrival', 'eco', 'housekeeping', 'auto-relock', 'comfort-auto'];

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
      // the motor is powered by that switch: give it time to come up (online again) before it is told to move, or
      // it misses the command and the shade stays where it is
      if (linked) {
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          await ST.refresh(id).catch(() => null);
          if (ST.realState(id, d.type)?.online) break;
          await new Promise(r => setTimeout(r, 700));
        }
        await new Promise(r => setTimeout(r, 1200));
      }
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
  const label = String(d.name).split(' · ')[0];
  const shown = Object.entries(args).map(([k, v]) => `${k} ${v}`).join(', ');
  journal({ kind: 'command', by, devices: [id], room: d.room,
    text: `${label} (${id}): ${command}${shown ? ` (${shown})` : ''} ${res.ok ? `done${res.via === 'smartthings' ? ' on the real SmartThings device' : ''}` : `FAILED: ${res.error}`}${note ? `; ${note}` : ''}` });
  if (res.ok && !AUTOMATION.includes(by)) for (const fn of listeners) { try { fn(d.room, id, by); } catch { /* a listener must not break a command */ } }
  return note && res.ok ? { ...res, note } : res;
}
