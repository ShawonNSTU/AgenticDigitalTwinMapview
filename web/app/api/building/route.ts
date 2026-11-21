import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildingState, uploadBuilding, loadKnownFloor, clearFloor } from '@/lib/sim/runtime';
import { TYPES } from '@/lib/sim/engine';

export const dynamic = 'force-dynamic';

const Room = z.object({ key: z.string().regex(/^[a-z0-9_-]+$/), name: z.string().min(1), x: z.tuple([z.number(), z.number()]), z: z.tuple([z.number(), z.number()]), poly: z.array(z.tuple([z.number(), z.number()])).min(3).max(200).optional(), color: z.string(), label: z.string().max(120).optional(), labelAt: z.tuple([z.number(), z.number()]).optional(), zone: z.string().max(20).optional() });
const Note = z.object({ text: z.string().min(1).max(60), x: z.number(), z: z.number(), size: z.number().positive().max(10).optional(), rot: z.number().optional() });
const Device = z.object({ id: z.string().min(2), type: z.string().refine(t => t in TYPES, 'unknown device type'), room: z.string(), name: z.string(), position: z.tuple([z.number(), z.number(), z.number()]), rotationY: z.number().optional() });
const Furniture = z.object({ kind: z.string().min(2).max(40), x: z.number(), z: z.number(), w: z.number().positive().max(60), d: z.number().positive().max(60), rot: z.number().optional(), h: z.number().positive().max(10).optional() });
const Body = z.object({
  rooms: z.array(Room).min(1).max(60),
  devices: z.array(Device).max(400),
  furniture: z.array(Furniture).max(5000).optional(),
  notes: z.array(Note).max(300).optional(),
  outdoorPad: z.object({ x: z.number(), z: z.number() }).optional(),
  title: z.string().min(1).max(80).optional(),
  plan: z.object({ dataUrl: z.string().max(12_000_000), x0: z.number(), x1: z.number(), z0: z.number(), z1: z.number() }).nullable().optional(),
});

/** GET: current layout (empty: true while no plan has been uploaded). POST: build an uploaded floor plan, its rooms
 *  and devices; or { known } for a floor recognised on upload, built from its checked model. DELETE: forget the floor. */
export async function GET() { return NextResponse.json(buildingState()); }

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => ({}));
  if (typeof raw?.known === 'string') {
    try { return NextResponse.json(loadKnownFloor(raw.known)); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  }
  const p = Body.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  const ids = new Set<string>();
  for (const d of p.data.devices) { if (ids.has(d.id)) return NextResponse.json({ error: `duplicate device id ${d.id}` }, { status: 400 }); ids.add(d.id); }
  try { return NextResponse.json(uploadBuilding(p.data)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

export async function DELETE() { return NextResponse.json(clearFloor()); }
