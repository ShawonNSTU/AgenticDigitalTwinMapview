import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildingState, setBuilding, resetBuilding } from '@/lib/sim/runtime';
import { TYPES } from '@/lib/sim/engine';

export const dynamic = 'force-dynamic';

const Room = z.object({ key: z.string().regex(/^[a-z0-9_-]+$/), name: z.string().min(1), x: z.tuple([z.number(), z.number()]), z: z.tuple([z.number(), z.number()]), color: z.string() });
const Device = z.object({ id: z.string().min(2), type: z.string().refine(t => t in TYPES, 'unknown device type'), room: z.string(), name: z.string(), position: z.tuple([z.number(), z.number(), z.number()]), rotationY: z.number().optional() });
const Body = z.object({
  rooms: z.array(Room).min(1).max(60),
  devices: z.array(Device).max(400),
  outdoorPad: z.object({ x: z.number(), z: z.number() }).optional(),
  plan: z.object({ dataUrl: z.string().max(12_000_000), x0: z.number(), x1: z.number(), z0: z.number(), z1: z.number() }).nullable().optional(),
});

/** GET: current layout. POST: replace it with an uploaded floor plan, its rooms and devices. DELETE: back to the sample home. */
export async function GET() { return NextResponse.json(buildingState()); }

export async function POST(req: NextRequest) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  const ids = new Set<string>();
  for (const d of p.data.devices) { if (ids.has(d.id)) return NextResponse.json({ error: `duplicate device id ${d.id}` }, { status: 400 }); ids.add(d.id); }
  try { return NextResponse.json(setBuilding(p.data.rooms, p.data.devices, p.data.outdoorPad, p.data.plan ?? null)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

export async function DELETE() { return NextResponse.json(resetBuilding()); }
