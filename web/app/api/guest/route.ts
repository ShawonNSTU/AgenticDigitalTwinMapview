import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createPass, listPasses, entranceRooms } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

const Body = z.object({ room: z.string().min(1), hours: z.number().min(0.25).max(24 * 30).default(24), entrance: z.string().optional(), label: z.string().max(60).optional() });

/** GET: active guest passes (optionally ?room=key) and the rooms a walk can start from. POST: a new pass for one room. */
export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get('room') ?? undefined;
  return NextResponse.json({ passes: listPasses(room), entrances: entranceRooms() });
}

export async function POST(req: NextRequest) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  try { return NextResponse.json(createPass(p.data.room, p.data.hours, p.data.entrance ?? '', p.data.label ?? '')); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
