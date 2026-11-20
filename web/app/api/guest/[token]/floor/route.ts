import { NextRequest, NextResponse } from 'next/server';
import { check, guestFloor } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

/** Live state for a guest's 3D view: like /api/floor, only the guest room's devices. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const c = check((await ctx.params).token);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: c.status });
  return NextResponse.json(guestFloor(c.pass));
}
