import { NextRequest, NextResponse } from 'next/server';
import { cookieName, check, guestView, revoke } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };

/** GET: the guest's room and its devices (state and allowed commands). DELETE: withdraw the pass (host). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const token = (await ctx.params).token;
  const c = check(token, _req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error, verify: !!c.verify }, { status: c.status });
  return NextResponse.json(guestView(c.pass));
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  return revoke((await ctx.params).token) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Unknown pass' }, { status: 404 });
}
