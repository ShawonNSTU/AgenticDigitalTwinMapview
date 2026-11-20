import { NextRequest, NextResponse } from 'next/server';
import { check, guestBuilding } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

/** The layout for a guest's 3D view: walls and doors to walk through, only the guest room's devices. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const c = check((await ctx.params).token);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: c.status });
  return NextResponse.json(guestBuilding(c.pass));
}
