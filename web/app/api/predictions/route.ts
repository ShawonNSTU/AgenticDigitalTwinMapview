import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { dispatchTech, dispatches, predictions, setDispatch } from '@/lib/experience/predict';
import { ensureExperience, refresh } from '@/lib/experience/loop';

export const dynamic = 'force-dynamic';

/** GET /api/predictions: predicted failures (when, why, how sure) and technicians on their way. */
export async function GET() {
  ensureExperience();
  return NextResponse.json({ predictions: predictions(), dispatches: dispatches() });
}

/** POST /api/predictions {deviceId, reason?}: send the right technician to a device (the 3D view draws the route). */
export async function POST(req: NextRequest) {
  const p = z.object({ deviceId: z.string().min(1).max(40), reason: z.string().max(200).optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: 'Say which device' }, { status: 400 });
  const x = dispatchTech(p.data.deviceId, p.data.reason);
  await refresh();
  return x ? NextResponse.json(x) : NextResponse.json({ error: 'Unknown device' }, { status: 404 });
}

/** PATCH /api/predictions {deviceId, status}: the technician is on site, or done. */
export async function PATCH(req: NextRequest) {
  const p = z.object({ deviceId: z.string().min(1).max(40), status: z.enum(['en_route', 'on_site', 'done']) }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  const x = setDispatch(p.data.deviceId, p.data.status);
  return x ? NextResponse.json(x) : NextResponse.json({ error: 'No dispatch for that device' }, { status: 404 });
}
