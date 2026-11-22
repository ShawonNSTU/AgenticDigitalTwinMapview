import { NextRequest, NextResponse } from 'next/server';
import { check, cookieName } from '@/lib/sim/guests';
import { guestOwner } from '@/lib/chatlog';
import { oneFor } from '@/lib/chatroutes';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string; id: string }> };
/** One of this guest's saved conversations: open, save, rename, delete (only while the pass is valid). */
const go = async (req: NextRequest, ctx: Ctx) => {
  const { token, id } = await ctx.params;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: c.status });
  return oneFor(guestOwner(token), id, req.method, req);
};
export { go as GET, go as PUT, go as PATCH, go as DELETE };
