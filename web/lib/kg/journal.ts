// The twin's journal: every action anyone takes on the website after a floor plan is loaded becomes one event
// (device commands from any source, real-device state reported by SmartThings, devices placed/moved/renamed/removed,
// floor plans uploaded, guests checked in/out, PINs, faults, alerts, maintenance records, routines, simulation).
// The knowledge graph (graph.ts) turns these into facts the assistant retrieves, so "who turned on Light 3?" or
// "what happened in the gym room today?" can be answered. Kept in memory and appended to .data/journal.jsonl, so it
// survives a restart. No imports from the simulator: anything can log without import cycles.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Kind = 'command' | 'reported' | 'device' | 'floor' | 'guest' | 'fault' | 'alert' | 'maintenance' | 'routine' | 'sim' | 'access';
export type JEvent = { at: number; kind: Kind; text: string; by?: string; devices?: string[]; room?: string; guest?: string };

const FILE = path.join(process.cwd(), '.data', 'journal.jsonl');
const MAX = 5000;
const g = globalThis as unknown as { __journal?: { events: JEvent[]; version: number } };
const J = (g.__journal ??= (() => {
  let events: JEvent[] = [];
  try { if (existsSync(FILE)) events = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-MAX); } catch { events = []; }
  return { events, version: 0 };
})());

/** Record one thing that happened. Never throws. */
export function log(e: Omit<JEvent, 'at'> & { at?: number }) {
  try {
    const ev: JEvent = { at: e.at ?? Date.now(), kind: e.kind, text: String(e.text).slice(0, 400), ...(e.by ? { by: e.by } : {}), ...(e.devices?.length ? { devices: e.devices } : {}), ...(e.room ? { room: e.room } : {}), ...(e.guest ? { guest: e.guest } : {}) };
    J.events.push(ev); J.version++;
    if (J.events.length > MAX) J.events.splice(0, J.events.length - MAX);
    mkdirSync(path.dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(ev) + '\n');
    if (J.version % 500 === 0) writeFileSync(FILE, J.events.map(x => JSON.stringify(x)).join('\n') + '\n');   // compact now and then
  } catch { /* the journal must never break an action */ }
}

export const events = () => J.events;
export const journalVersion = () => J.version;
/** A new floor plan starts a new building: earlier history is about rooms that no longer exist. */
export function resetJournal() { J.events = []; J.version++; try { mkdirSync(path.dirname(FILE), { recursive: true }); writeFileSync(FILE, ''); } catch { /* memory only */ } }
