import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { check, guestCommand } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

const Body = z.object({ command: z.string(), args: z.record(z.unknown()).optional() });

/** A guest runs a command on a device in their room (commands that need confirmation are not allowed). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await ctx.params;
  const c = check(token);
  if ('error' in c) return NextResponse.json({ ok: false, error: c.error }, { status: c.status });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: p.error.message }, { status: 400 });
  const r = guestCommand(c.pass, id, p.data.command, p.data.args ?? {});
  return NextResponse.json(r.body, { status: r.status });
}
