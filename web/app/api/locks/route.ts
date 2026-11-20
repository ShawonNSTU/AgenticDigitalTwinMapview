import { NextRequest, NextResponse } from 'next/server';
import { auditLog, policy } from '@/lib/sim/access';

export const dynamic = 'force-dynamic';

/** GET ?device=: the door-access audit log (every lock and unlock attempt, newest first) and the policy. */
export async function GET(req: NextRequest) {
  return NextResponse.json({ policy: policy(), audit: auditLog(req.nextUrl.searchParams.get('device') ?? undefined).slice(0, 200) });
}
