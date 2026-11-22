import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { comfort, roomComfort } from '@/lib/experience/comfort';
import { ensureExperience, refresh } from '@/lib/experience/loop';
import { dispatch } from '@/lib/sim/dispatch';

export const dynamic = 'force-dynamic';

/** GET /api/comfort[?room=key]: comfort score, its parts, measured vs estimated, and advice per room. */
export async function GET(req: NextRequest) {
  ensureExperience();
  const room = req.nextUrl.searchParams.get('room');
  if (room) { const c = roomComfort(room); return c ? NextResponse.json(c) : NextResponse.json({ error: 'No comfort data for that room' }, { status: 404 }); }
  return NextResponse.json({ rooms: comfort() });
}

/** POST /api/comfort {room}: apply the room's comfort advice (staff). */
export async function POST(req: NextRequest) {
  const p = z.object({ room: z.string().min(1).max(80) }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: 'Say which room' }, { status: 400 });
  const before = roomComfort(p.data.room);
  if (!before) return NextResponse.json({ error: 'No comfort data for that room' }, { status: 404 });
  const applied = [];
  for (const a of before.advice) for (const x of a.actions) {
    const r = await dispatch(x.id, x.command, x.args ?? {}, false, 'host');
    applied.push({ id: x.id, command: x.command, ok: r.ok, ...(r.ok ? {} : { error: r.error }), via: r.via });
  }
  await refresh();
  return NextResponse.json({ before: { score: before.score }, applied, after: roomComfort(p.data.room) });
}
