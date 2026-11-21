// Routines: a named set of device commands for a room ("Movie night", "Good night", "Welcome"). Each routine says
// what every device TYPE does; a room runs it on the devices it has (a real SmartThings device gets the real
// command through dispatch; a guest only gets what the guest pass allows).
export type Cmd = { command: string; args?: Record<string, unknown> };
export type Routine = { id: string; name: string; about: string; steps: Record<string, Cmd[]> };

const on = { command: 'power', args: { on: 'true' } }, off = { command: 'power', args: { on: 'false' } };

export const ROUTINES: Routine[] = [
  { id: 'movie', name: 'Movie night', about: 'Dim warm lights, close the blinds, TV on',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 2700 } }, { command: 'setLevel', args: { percent: 15 } }], blinds: [{ command: 'close' }], tv: [on], speaker: [] } },
  { id: 'sleep', name: 'Good night', about: 'Lights, TV and fans off, blinds closed, AC 24 °C, purifier on low',
    steps: { light: [off], blinds: [{ command: 'close' }], tv: [off], fan: [off], ac: [{ command: 'setMode', args: { mode: 'cool' } }, { command: 'setTemperature', args: { celsius: 24 } }, { command: 'setFanSpeed', args: { percent: 30 } }], purifier: [{ command: 'setFan', args: { level: 1 } }] } },
  { id: 'morning', name: 'Good morning', about: 'Blinds open, bright neutral lights, TV off',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 4000 } }, { command: 'setLevel', args: { percent: 70 } }], blinds: [{ command: 'open' }], tv: [off] } },
  { id: 'welcome', name: 'Welcome', about: 'Lights on, blinds open, AC 24 °C',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 3500 } }, { command: 'setLevel', args: { percent: 80 } }], blinds: [{ command: 'open' }], ac: [{ command: 'setMode', args: { mode: 'cool' } }, { command: 'setTemperature', args: { celsius: 24 } }] } },
  { id: 'focus', name: 'Focus', about: 'Bright cool lights, blinds open, TV off',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 5000 } }, { command: 'setLevel', args: { percent: 100 } }], blinds: [{ command: 'open' }], tv: [off] } },
  { id: 'away', name: 'Away', about: 'Everything off, blinds closed',
    steps: { light: [off], tv: [off], fan: [off], purifier: [off], blinds: [{ command: 'close' }], ac: [off] } },
];
export const routineById = (id: string) => ROUTINES.find(r => r.id === id);

/* ---------------- routines people save ----------------
   A saved routine is the exact device commands of something that was just done ("dim Light 1, close the shade, TV
   on"), kept under a name for one owner: the staff, or one guest pass. Kept in memory and in .data/routines.json, so
   they survive a restart of the web app. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { log as journal } from '@/lib/kg/journal';
import path from 'node:path';

export type SavedStep = { deviceId: string; command: string; args: Record<string, unknown> };
export type SavedRoutine = { id: string; name: string; owner: string; steps: SavedStep[]; createdAt: number };

const FILE = path.join(process.cwd(), '.data', 'routines.json');
const g = globalThis as unknown as { __savedRoutines?: SavedRoutine[] };
const saved: SavedRoutine[] = (g.__savedRoutines ??= (() => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []; } catch { return []; } })());
const persist = () => { try { mkdirSync(path.dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(saved, null, 1)); } catch { /* read-only disk: memory only */ } };

const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'routine';
export const savedFor = (owner: string) => saved.filter(r => r.owner === owner);
export const savedById = (owner: string, id: string) => saved.find(r => r.owner === owner && r.id === id);

/** Save (or replace, same name) a routine for an owner. */
export function saveRoutine(owner: string, name: string, steps: SavedStep[]) {
  const clean = name.trim().slice(0, 40);
  if (!clean) throw new Error('A routine needs a name');
  if (!steps.length) throw new Error('There is nothing to save');
  if (steps.length > 60) throw new Error('That is too many steps for one routine');
  const id = `c-${slug(clean)}`;
  const at = saved.findIndex(r => r.owner === owner && r.id === id);
  const r: SavedRoutine = { id, name: clean, owner, steps, createdAt: Date.now() };
  if (at >= 0) saved[at] = r; else saved.push(r);
  persist();
  journal({ kind: 'routine', by: owner.startsWith('guest:') ? 'guest' : 'staff', devices: [...new Set(steps.map(s => s.deviceId))], text: `Routine "${clean}" saved (${steps.length} steps)` });
  return r;
}
export function deleteRoutine(owner: string, id: string) {
  const at = saved.findIndex(r => r.owner === owner && r.id === id);
  if (at < 0) return false;
  journal({ kind: 'routine', text: `Routine "${saved[at].name}" deleted` });
  saved.splice(at, 1); persist();
  return true;
}
