import { NextRequest, NextResponse } from 'next/server';
import { knownFloorPlan } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** POST { image: dataURL } → assistant /floorplan/parse → rooms, doors, furniture and the scale, in 0..1 image
 *  coordinates, plus a cleaned and cropped image for the 3D floor. A floor the platform already has a checked model
 *  of comes back as { known } and is filled in here from that model, so the editor shows it like any other plan. */
export async function POST(req: NextRequest) {
  const base = (process.env.ASSISTANT_URL ?? process.env.ST_AGENT_URL ?? 'http://localhost:8100');
  let r: Response;
  try {
    r = await fetch(`${base}/floorplan/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await req.text() });
  } catch {
    return NextResponse.json({ error: `The plan reader (the assistant at ${base}) is not reachable. Start it, or draw the rooms by hand.` }, { status: 502 });
  }
  const j = await r.json().catch(() => ({ error: 'The plan reader sent an unreadable reply' }));
  if (r.ok && j.known) {
    const k = knownFloorPlan(j.known);
    if (k) return NextResponse.json({ ...j, ...k, width_m: k.widthM });
  }
  return NextResponse.json(j, { status: r.status });
}
