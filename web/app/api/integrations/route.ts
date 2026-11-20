import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as ST from '@/lib/integrations/smartthings';
import { policy, setPolicy } from '@/lib/sim/access';

export const dynamic = 'force-dynamic';

/** GET: SmartThings connection and links, and the door-access policy. POST {token?, policy?}: connect, change the policy. */
export async function GET() { return NextResponse.json({ smartthings: ST.info(), lockPolicy: policy() }); }

export async function POST(req: NextRequest) {
  const p = z.object({ token: z.string().max(400).optional(), policy: z.object({ stepUpMinutes: z.number().min(0).max(1440), maxUnlocksPer10Min: z.number().min(1).max(100), autoRelockSec: z.number().min(0).max(3600) }).partial().optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  if (p.data.token != null) ST.setToken(p.data.token);
  if (p.data.policy) setPolicy(p.data.policy);
  return NextResponse.json({ smartthings: ST.info(), lockPolicy: policy() });
}
