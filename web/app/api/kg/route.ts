import { NextRequest, NextResponse } from 'next/server';
import { brief, knowledge } from '@/lib/kg/graph';

export const dynamic = 'force-dynamic';

/** GET: what the assistant knows, for the staff's agent panel: counts and what needs attention (?graph=1: the whole
 *  graph with nodes, edges and documents). Role from the sign-in cookie, like /api/chat. */
export async function GET(req: NextRequest) {
  const role = (req.cookies.get('twin_role')?.value ?? '').startsWith('tech:') ? 'technician' : 'admin';
  const scope = { kind: 'host' as const, role: role as 'admin' | 'technician' };
  return NextResponse.json(req.nextUrl.searchParams.get('graph') ? knowledge(scope) : brief(scope));
}
