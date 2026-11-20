import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { byId, clearFault, faultCatalog, LEVELS, setFault, TYPES } from '@/lib/sim/engine';
import { device, tick } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/devices/:id/fault → the faults this device type can simulate, the severity levels and the active fault. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const d = byId[id];
  if (!d) return NextResponse.json({ error: `Unknown device ${id}` }, { status: 404 });
  return NextResponse.json({ id, type: d.type, label: TYPES[d.type].label, levels: LEVELS.map(({ key, name }) => ({ key, name })), faults: faultCatalog(d.type), active: device(id, tick())?.fault ?? null });
}

const Body = z.object({ key: z.string().min(1).max(40), level: z.enum(['early', 'developing', 'severe']).default('developing') });

/** POST /api/devices/:id/fault {key, level} → simulate a fault on this device. It develops over about 6 s. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  const r = setFault(id, p.data.key, p.data.level);
  return r.ok ? NextResponse.json(device(id, tick())) : NextResponse.json({ error: r.error }, { status: byId[id] ? 400 : 404 });
}

/** DELETE /api/devices/:id/fault → back to normal operation. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!byId[id]) return NextResponse.json({ error: `Unknown device ${id}` }, { status: 404 });
  clearFault(id);
  return NextResponse.json(device(id, tick()));
}
