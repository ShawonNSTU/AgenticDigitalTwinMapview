import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { check, cookieName, verifyPin } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

/** The guest enters the check-in PIN from the front desk; a signed cookie remembers it for this pass. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const p = z.object({ pin: z.string().min(1).max(12) }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: 'Enter the PIN' }, { status: 400 });
  const pre = check(token, null, false);
  if ('error' in pre) return NextResponse.json({ error: pre.error }, { status: pre.status });
  const v = verifyPin(token, p.data.pin);
  if ('error' in v) return NextResponse.json({ error: v.error }, { status: v.status });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName(token), v.cookie, { httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(pre.pass.expiresAt) });
  return res;
}
