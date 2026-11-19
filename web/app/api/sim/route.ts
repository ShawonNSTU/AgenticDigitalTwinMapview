import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { simState, setSim, tick } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

const Body = z.object({ scenario: z.string().optional(), t: z.number().optional(), playing: z.boolean().optional(), speed: z.number().optional(), fix: z.boolean().optional() });

/** GET: clock and scenario. POST: change scenario, time, play state, or mark the current fault fixed. */
export async function GET() { tick(); return NextResponse.json(simState()); }
export async function POST(req: NextRequest) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  tick();
  return NextResponse.json(setSim(p.data));
}
