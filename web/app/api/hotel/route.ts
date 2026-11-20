import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { guestRoomCandidates, setUpGuestRoom, setUpHotel, GUEST_KIT } from '@/lib/sim/hotel';

export const dynamic = 'force-dynamic';

const Body = z.object({ room: z.string().optional(), rooms: z.array(z.string()).optional() });

/** GET: rooms that can be guest rooms and the devices a guest room gets. POST {room}: set up one room;
 *  POST {rooms?}: set up several (all candidates when none are named). */
export async function GET() { return NextResponse.json({ candidates: guestRoomCandidates(), kit: GUEST_KIT }); }

export async function POST(req: NextRequest) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  if (p.data.room) {
    const r = setUpGuestRoom(p.data.room);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }
  return NextResponse.json(setUpHotel(p.data.rooms));
}
