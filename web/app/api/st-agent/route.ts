import { NextRequest, NextResponse } from 'next/server';
import { agentHealth, agentTurn } from '@/lib/integrations/stagent';

export const dynamic = 'force-dynamic';

/** GET: is the SmartThings agent up. POST {messages: [{role, content}], room?}: one turn with it about a room's
 *  devices (default: the SmartThings Experience Zone), as the host. Answers with the chat event stream. */
export async function GET() { return NextResponse.json(await agentHealth()); }

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  return agentTurn({ messages: Array.isArray(b.messages) ? b.messages : [] }, { kind: 'host', ...(typeof b.room === 'string' && b.room ? { room: b.room } : {}) });
}
