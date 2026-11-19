import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { device, tick, moveDevice, removeDevice } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/devices/:id?t=12.5 → readings, parts with health, finding with guided steps. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = req.nextUrl.searchParams.get('t');
  const d = device(id, t ? Number(t) : tick());
  return d ? NextResponse.json(d) : NextResponse.json({ error: `Unknown device ${id}` }, { status: 404 });
}

const Move = z.object({ x: z.number().finite().optional(), z: z.number().finite().optional(), y: z.number().finite().optional(), rotationY: z.number().finite().optional() });

/** PATCH /api/devices/:id {x, z, rotationY} → move a placed device. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Move.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  const r = moveDevice(id, p.data);
  return r.ok ? NextResponse.json(r.device) : NextResponse.json({ error: r.error }, { status: 404 });
}

/** DELETE /api/devices/:id → take a device off the floor. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = removeDevice(id);
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 404 });
}
