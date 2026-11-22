import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as arrival from '@/lib/experience/arrival';
import { revoke } from '@/lib/sim/guests';
import { ensureExperience, refresh } from '@/lib/experience/loop';

export const dynamic = 'force-dynamic';

/** GET /api/arrivals: every current stay's journey (expected, preparing, ready, in the room, away) and housekeeping. */
export async function GET() {
  ensureExperience();
  return NextResponse.json({ journeys: arrival.journeys().map(j => ({ token: j.token, ...arrival.publicJourney(j) })), housekeeping: arrival.housekeeping() });
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('eta'), token: z.string(), minutes: z.number().min(0).max(1440) }),
  z.object({ action: z.literal('prepare'), token: z.string() }),
  z.object({ action: z.literal('checkout'), token: z.string() }),
  z.object({ action: z.literal('housekeeping'), id: z.string(), status: z.enum(['requested', 'in_progress', 'done']) }),
]);

/** POST /api/arrivals: the front desk's side: set an ETA, prepare a room now, check a guest out, update housekeeping. */
export async function POST(req: NextRequest) {
  ensureExperience();
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? 'Bad request' }, { status: 400 });
  const b = p.data;
  if (b.action === 'housekeeping') { const h = arrival.setHousekeeping(b.id, b.status); return h ? NextResponse.json(h) : NextResponse.json({ error: 'No such task' }, { status: 404 }); }
  const j0 = arrival.journey(b.token);
  if (!j0) return NextResponse.json({ error: 'No such stay' }, { status: 404 });
  if (b.action === 'eta') arrival.onMyWay(b.token, b.minutes, 'host');
  if (b.action === 'prepare') await arrival.prepare(b.token, 'front desk');
  if (b.action === 'checkout') { await arrival.checkout(b.token, 'front desk'); revoke(b.token, 'front desk'); }
  await refresh();
  return NextResponse.json(arrival.publicJourney(arrival.journey(b.token)));
}
