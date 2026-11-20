import { NextRequest } from 'next/server';
import { check, cookieName } from '@/lib/sim/guests';

export const dynamic = 'force-dynamic';

/** POST: the guest's room assistant (agent backend /guest/chat). The pass is checked here and again on every
 *  device call the agent makes, which goes through the guest API with the guest's own cookie. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if ('error' in c) return new Response(sse('error', { message: c.error }) + sse('done', {}), { status: c.status, headers: { 'Content-Type': 'text/event-stream' } });
  const body = await req.json().catch(() => ({}));
  const base = process.env.AGENT_URL ?? 'http://localhost:8000';
  try {
    const upstream = await fetch(`${base}/guest/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, cookie: req.headers.get('cookie') ?? '', messages: body.messages ?? [], confirm: body.confirm ?? null }) });
    return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  } catch {
    return new Response(sse('error', { message: `The assistant is not reachable (${base}). Start agent-backend.` }) + sse('done', {}), { status: 502, headers: { 'Content-Type': 'text/event-stream' } });
  }
}
