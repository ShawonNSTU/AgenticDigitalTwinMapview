/* Saved assistant conversations, kept per person: the administrator, each technician (their sign-in key) and each
   guest pass. A conversation is stored as the runs the chat panel shows (request, steps, changes, answer, sources),
   so opening one brings it back as it was and the conversation goes on from there. Kept in .data/chats.json, so
   they survive a restart of the web app; a guest's conversations go when their pass is withdrawn or expires. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Chat = { id: string; owner: string; title: string; createdAt: number; updatedAt: number; runs: unknown[] };
export type ChatBrief = { id: string; title: string; createdAt: number; updatedAt: number; turns: number; preview: string };

const FILE = path.join(process.cwd(), '.data', 'chats.json');
const MAX_PER_OWNER = 100;   // oldest conversations go first
const MAX_RUNS = 200;        // per conversation
const MAX_BYTES = 400_000;   // per conversation, as stored

const g = globalThis as unknown as { __chats?: Chat[] };
const chats: Chat[] = (g.__chats ??= (() => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []; } catch { return []; } })());
let timer: ReturnType<typeof setTimeout> | null = null;
const persist = () => {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { mkdirSync(path.dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(chats)); } catch { /* read-only disk: memory only */ }
  }, 300);
};

const ask = (r: unknown) => (r && typeof r === 'object' && typeof (r as any).ask === 'string' ? String((r as any).ask) : '');
const answer = (r: unknown) => (r && typeof r === 'object' && typeof (r as any).text === 'string' ? String((r as any).text) : '');
const titleOf = (runs: unknown[]) => {
  const first = ask(runs[0]).replace(/\s+/g, ' ').trim();
  return first ? (first.length > 60 ? first.slice(0, 57) + '…' : first) : 'New conversation';
};
const brief = (c: Chat): ChatBrief => {
  const last = c.runs[c.runs.length - 1];
  const prev = (answer(last) || ask(last)).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.runs.length, preview: prev.length > 90 ? prev.slice(0, 87) + '…' : prev };
};

/** The person's conversations, newest first. */
export function listChats(owner: string): ChatBrief[] {
  return chats.filter(c => c.owner === owner).sort((a, b) => b.updatedAt - a.updatedAt).map(brief);
}

export function getChat(owner: string, id: string): Chat | undefined {
  return chats.find(c => c.owner === owner && c.id === id);
}

const ID = /^[A-Za-z0-9_-]{6,40}$/;

/** Create or update a conversation (the panel sends all its runs after each one ends). */
export function saveChat(owner: string, id: string, runs: unknown[], title?: string): ChatBrief | { error: string } {
  if (!ID.test(id)) return { error: 'bad conversation id' };
  if (!Array.isArray(runs)) return { error: 'runs must be a list' };
  // runs still streaming when the page went away are kept as stopped
  let kept = runs.slice(-MAX_RUNS).map(r => (r && typeof r === 'object' && (r as any).status === 'running' ? { ...(r as object), status: 'stopped' } : r));
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_BYTES) kept = kept.slice(1);
  let c = getChat(owner, id);
  const now = Date.now();
  if (!c) {
    if (chats.some(x => x.id === id)) return { error: 'conversation id in use' };
    c = { id, owner, title: '', createdAt: now, updatedAt: now, runs: [] };
    chats.push(c);
    const mine = chats.filter(x => x.owner === owner).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PER_OWNER))) chats.splice(chats.indexOf(old), 1);
  }
  c.runs = kept;
  c.title = (typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : '') || c.title || titleOf(kept);
  c.updatedAt = now;
  persist();
  return brief(c);
}

export function renameChat(owner: string, id: string, title: string): boolean {
  const c = getChat(owner, id);
  if (!c || !title.trim()) return false;
  c.title = title.trim().slice(0, 80);
  persist();
  return true;
}

export function deleteChat(owner: string, id: string): boolean {
  const i = chats.findIndex(c => c.owner === owner && c.id === id);
  if (i < 0) return false;
  chats.splice(i, 1);
  persist();
  return true;
}

/** Drop every conversation of an owner (a guest pass withdrawn or expired). */
export function dropOwner(owner: string) {
  let n = 0;
  for (let i = chats.length - 1; i >= 0; i--) if (chats[i].owner === owner) { chats.splice(i, 1); n++; }
  if (n) persist();
}

/** Who a staff request belongs to: each technician by their sign-in key, everyone else is the administrator. */
export function staffOwner(roleCookie: string | undefined): string {
  const v = roleCookie ?? '';
  return v.startsWith('tech:') ? v : 'admin';
}
export const guestOwner = (token: string) => `guest:${token}`;
