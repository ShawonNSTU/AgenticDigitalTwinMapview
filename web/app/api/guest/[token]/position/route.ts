import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { check, cookieName } from '@/lib/sim/guests';
import { checkpoint, config, fixOf, setFix } from '@/lib/sim/positioning';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };

const Body = z.object({
  checkpoint: z.string().max(16).optional(),
  x: z.number().optional(), z: z.number().optional(), accuracy: z.number().min(0).max(50).optional(), heading: z.number().optional(),
  source: z.enum(['pdr', 'rtls-sim']).optional(),
});

/** GET: the guest's latest position and the positioning settings their phone needs (north, step length).
 *  POST: a fix from the guest's phone: a scanned location code {checkpoint}, or a step-tracking estimate {x, z, accuracy}. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const cf = config();
  return NextResponse.json({ fix: fixOf(token), northDeg: cf.northDeg, stepLength: cf.stepLength });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  if (p.data.checkpoint) {
    const cp = checkpoint(p.data.checkpoint);
    if (!cp) return NextResponse.json({ error: 'Unknown location code' }, { status: 404 });
    return NextResponse.json({ fix: setFix(token, { x: cp.x, z: cp.z, accuracy: 1, source: 'checkpoint', checkpoint: cp.label }), label: cp.label });
  }
  if (p.data.x == null || p.data.z == null) return NextResponse.json({ error: 'x and z, or checkpoint' }, { status: 400 });
  return NextResponse.json({ fix: setFix(token, { x: p.data.x, z: p.data.z, accuracy: p.data.accuracy ?? 3, source: p.data.source ?? 'pdr', heading: p.data.heading }) });
}
