import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { COMMANDS } from '@/lib/sim/runtime';
import { dispatch } from '@/lib/sim/dispatch';
import { byId } from '@/lib/sim/engine';
import { supported } from '@/lib/integrations/smartthings';

export const dynamic = 'force-dynamic';

const Body = z.object({ command: z.string(), args: z.record(z.unknown()).optional(), confirmed: z.boolean().optional(), by: z.string().optional() });

/** GET: supported commands for this device. POST: run a whitelisted command. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const d = byId[id];
  if (!d) return NextResponse.json({ error: `Unknown device ${id}` }, { status: 404 });
  const cmds = COMMANDS[d.type] ?? {};
  // a device linked to SmartThings offers only what the real device supports
  return NextResponse.json({ id, commands: supported(id, d.type, Object.entries(cmds).filter(([, c]) => !c.hidden).map(([name, c]) => ({ name, args: (c.args ?? {}) as Record<string, any>, needsConfirmation: !!c.confirm }))) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  const { command, args, confirmed, by } = parsed.data;
  const r = await dispatch(id, command, args ?? {}, !!confirmed, by ?? 'user');
  return NextResponse.json(r, { status: r.ok ? 200 : r.needsConfirmation ? 409 : 400 });
}
