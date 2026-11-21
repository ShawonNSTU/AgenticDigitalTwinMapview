import { NextRequest } from 'next/server';
import { check, cookieName } from '@/lib/sim/guests';
import { agentTurn } from '@/lib/integrations/stagent';

export const dynamic = 'force-dynamic';

/** POST {messages}: the guest's assistant, the same agent as the staff's but limited to the guest's room and the
 *  pass's controls. The pass is checked here, and every device call the agent makes is checked again against it
 *  (lib/integrations/stagent.ts). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const c = check(token, req.cookies.get(cookieName(token))?.value);
  if ('error' in c) {
    const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return new Response(sse('error', { message: c.error }) + sse('done', {}), { status: c.status, headers: { 'Content-Type': 'text/event-stream' } });
  }
  const b = await req.json().catch(() => ({}));
  return agentTurn({ messages: Array.isArray(b.messages) ? b.messages : [] }, { kind: 'guest', pass: c.pass }, { guest: true });
}
