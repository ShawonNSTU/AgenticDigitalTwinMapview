import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { cookieName, check, guestCommands } from '@/lib/sim/guests';
import { byId } from '@/lib/sim/engine';
import * as arrival from '@/lib/experience/arrival';
import { ensureExperience, refresh } from '@/lib/experience/loop';
import { roomComfort } from '@/lib/experience/comfort';
import { summary } from '@/lib/experience/energy';
import { dispatch } from '@/lib/sim/dispatch';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };

/** GET: the guest's journey (state, ETA, welcome steps), their room's comfort and energy. */
export async function GET(req: NextRequest, ctx: Ctx) {
  ensureExperience();
  const token = (await ctx.params).token;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error, verify: !!c.verify }, { status: c.status });
  return NextResponse.json({ journey: arrival.publicJourney(arrival.journey(token)), comfort: roomComfort(c.pass.room), energy: summary(c.pass.room) });
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('on_my_way'), minutes: z.number().min(0).max(1440) }),
  z.object({ action: z.literal('walking'), metres: z.number().min(0).max(5000) }),
  z.object({ action: z.literal('arrived'), via: z.string().max(40).optional() }),
  z.object({ action: z.literal('away') }),
  z.object({ action: z.literal('prepare') }),
  z.object({ action: z.literal('prefs'), prefs: z.object({ temp: z.number().min(16).max(30).optional(), scene: z.enum(['warm', 'bright', 'calm', 'off']).optional(), curtain: z.number().min(0).max(100).optional(), tvWelcome: z.boolean().optional() }) }),
  z.object({ action: z.literal('comfort') }),
]);

/** POST: the guest's side of the journey: on my way, walking (from the 3D walk), arrived, away, preferences,
 *  "prepare now", and "make it comfortable" (runs the comfort advice on their own room's devices). */
export async function POST(req: NextRequest, ctx: Ctx) {
  ensureExperience();
  const token = (await ctx.params).token;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) return NextResponse.json({ error: c.error, verify: !!c.verify }, { status: c.status });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? 'Bad request' }, { status: 400 });
  const b = p.data;
  if (b.action === 'on_my_way') arrival.onMyWay(token, b.minutes);
  if (b.action === 'walking') arrival.walking(token, b.metres);
  if (b.action === 'arrived') arrival.arrived(token, b.via ?? 'walk');
  if (b.action === 'away') await arrival.away(token);
  if (b.action === 'prepare') await arrival.prepare(token, 'guest asked');
  if (b.action === 'prefs') arrival.setPrefs(token, b.prefs);
  let applied: { id: string; command: string; ok: boolean; error?: string }[] | undefined;
  if (b.action === 'comfort') {
    const rc = roomComfort(c.pass.room);
    applied = [];
    for (const a of rc?.advice ?? []) for (const x of a.actions) {
      // only what this guest may do on their own room's devices
      if (!byId[x.id] || byId[x.id].room !== c.pass.room || !guestCommands(byId[x.id].type, c.pass, x.id).some((g: any) => g.name === x.command)) continue;
      const r = await dispatch(x.id, x.command, x.args ?? {}, false, 'guest');
      applied.push({ id: x.id, command: x.command, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    }
  }
  await refresh();
  return NextResponse.json({ journey: arrival.publicJourney(arrival.journey(token)), comfort: roomComfort(c.pass.room), ...(applied ? { applied } : {}) });
}
