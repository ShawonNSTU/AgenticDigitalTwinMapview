import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** POST { image: dataURL } → agent backend /floorplan/parse → { rooms: [{ name, x0, y0, x1, y1 }] } in 0..1 image coordinates. */
export async function POST(req: NextRequest) {
  const base = process.env.AGENT_URL ?? 'http://localhost:8000';
  try {
    const r = await fetch(`${base}/floorplan/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await req.text() });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return NextResponse.json({ error: `Agent backend not reachable at ${base}. Draw the rooms by hand instead.` }, { status: 502 });
  }
}
