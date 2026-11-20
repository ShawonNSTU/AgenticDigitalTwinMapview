import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { FURNITURE, addFurniture, editFurniture, roomFurniture } from '@/lib/sim/hotel';

export const dynamic = 'force-dynamic';

/** GET ?room=: the room's furniture and what can be added. POST {room, kind}: add at the best free spot.
 *  PATCH {id, dx?, dz?, turn?, remove?}: move, turn or remove (with the rest of a set). */
export async function GET(req: NextRequest) {
  return NextResponse.json({ kinds: Object.entries(FURNITURE).map(([kind, f]) => ({ kind, label: f.label })), furniture: roomFurniture(req.nextUrl.searchParams.get('room') ?? '') });
}
export async function POST(req: NextRequest) {
  const p = z.object({ room: z.string(), kind: z.string() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  const r = addFurniture(p.data.room, p.data.kind);
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
export async function PATCH(req: NextRequest) {
  const p = z.object({ id: z.string(), dx: z.number().min(-5).max(5).optional(), dz: z.number().min(-5).max(5).optional(), turn: z.number().optional(), remove: z.boolean().optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  const r = editFurniture(p.data.id, p.data);
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
