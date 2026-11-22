/* The chat-history endpoints, shared by staff (/api/chat/history) and guests (/api/guest/{pass}/chat/history):
 *   GET    .../history            -> { chats: [{ id, title, createdAt, updatedAt, turns, preview }] }  newest first
 *   GET    .../history/{id}       -> { id, title, createdAt, updatedAt, runs }
 *   PUT    .../history/{id}       {runs, title?} -> the conversation's summary (created on first save)
 *   PATCH  .../history/{id}       {title}        -> rename
 *   DELETE .../history/{id}
 * Every call only sees the caller's own conversations (owner from the sign-in or the pass). */
import { NextResponse } from 'next/server';
import { deleteChat, getChat, listChats, renameChat, saveChat } from '@/lib/chatlog';

export const listFor = (owner: string) => NextResponse.json({ chats: listChats(owner) });

export async function oneFor(owner: string, id: string, method: string, req: Request) {
  if (method === 'GET') {
    const c = getChat(owner, id);
    return c ? NextResponse.json({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, runs: c.runs }) : NextResponse.json({ error: 'No such conversation' }, { status: 404 });
  }
  if (method === 'DELETE') return deleteChat(owner, id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'No such conversation' }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  if (method === 'PATCH') return renameChat(owner, id, String(b.title ?? '')) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'No such conversation' }, { status: 404 });
  const r = saveChat(owner, id, b.runs, typeof b.title === 'string' ? b.title : undefined);
  return 'error' in r ? NextResponse.json(r, { status: 400 }) : NextResponse.json(r);
}
