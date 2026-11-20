import { NextRequest, NextResponse } from 'next/server';
import { cookieName, check, guestBuilding } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

/** The layout for a guest's 3D view: walls and doors to walk through, only the guest room's devices. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const token = (await ctx.params).token;
  const c = check(token, _req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error, verify: !!c.verify }, { status: c.status });
  return NextResponse.json(guestBuilding(c.pass));
}
