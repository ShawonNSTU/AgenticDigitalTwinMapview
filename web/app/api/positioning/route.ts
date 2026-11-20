import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkpoints, config, setConfig } from '@/lib/sim/positioning';

export const dynamic = 'force-dynamic';

/** GET: positioning settings, the RTLS webhook and the location QR checkpoints. POST {northDeg?, stepLength?}. */
export async function GET() { return NextResponse.json({ config: config(), webhook: '/api/positioning/rtls', checkpoints: checkpoints() }); }

export async function POST(req: NextRequest) {
  const p = z.object({ northDeg: z.number().optional(), stepLength: z.number().optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  return NextResponse.json({ config: setConfig(p.data) });
}
