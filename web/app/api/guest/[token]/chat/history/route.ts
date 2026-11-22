import { NextRequest, NextResponse } from 'next/server';
import { check, cookieName } from '@/lib/sim/guests';
import { guestOwner } from '@/lib/chatlog';
import { listFor } from '@/lib/chatroutes';

export const dynamic = 'force-dynamic';

/** GET: this guest's saved assistant conversations (only while the pass is valid). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: c.status });
  return listFor(guestOwner(token));
}
