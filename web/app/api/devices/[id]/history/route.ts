import { NextRequest, NextResponse } from 'next/server';
import { partHistory, byId, TYPES } from '@/lib/sim/engine';
import { tick } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/devices/:id/history?part=filter → { unit, now, points: [[hour, value], ...] } from 06:00 to 22:00. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const part = req.nextUrl.searchParams.get('part');
  if (!byId[id] || !part) return NextResponse.json({ error: 'Unknown device or missing ?part=' }, { status: 400 });
  const spec = TYPES[byId[id].type].parts.find((p: { key: string }) => p.key === part);
  if (!spec) return NextResponse.json({ error: `${id} has no part "${part}"` }, { status: 400 });
  return NextResponse.json({ id, part, unit: spec.u ?? '', now: +tick().toFixed(2), points: partHistory(id, part) });
}
