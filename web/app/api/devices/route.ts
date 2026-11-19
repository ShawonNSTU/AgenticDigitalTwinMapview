import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { floor, addDevice } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/**
 * GET /api/devices?type=ac&room=bedroom&health=fault
 * Plain filtering. Natural-language search lives in the agent backend.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  let list = floor().devices;
  for (const k of ['type', 'room', 'health'] as const) {
    const v = q.get(k);
    if (v) list = list.filter(d => d[k] === v);
  }
  return NextResponse.json({ count: list.length, devices: list });
}

const Add = z.object({
  type: z.string().min(2).max(20),
  x: z.number().finite(), z: z.number().finite(),
  y: z.number().finite().optional(),
  rotationY: z.number().finite().optional(),
  room: z.string().max(80).optional(),
  name: z.string().max(80).optional(),
  id: z.string().regex(/^[A-Z0-9-]{2,20}$/).optional(),
});

/** POST /api/devices {type, x, z, rotationY?, room?} → place a SmartThings device on the floor (map drag and drop). */
export async function POST(req: NextRequest) {
  const p = Add.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  const r = addDevice(p.data);
  return r.ok ? NextResponse.json(r.device, { status: 201 }) : NextResponse.json({ error: r.error }, { status: 400 });
}
