import { NextRequest, NextResponse } from 'next/server';
import { device, tick } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/devices/:id?t=12.5 → readings, parts with health, finding with guided steps. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = req.nextUrl.searchParams.get('t');
  const d = device(id, t ? Number(t) : tick());
  return d ? NextResponse.json(d) : NextResponse.json({ error: `Unknown device ${id}` }, { status: 404 });
}
