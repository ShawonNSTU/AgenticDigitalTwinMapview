import { NextRequest, NextResponse } from 'next/server';
import { agentHealth, agentTurn } from '@/lib/integrations/stagent';

export const dynamic = 'force-dynamic';

/**
 * The assistant for staff: ONE agent (smartthings-agent) for the administrator and the technician. It controls and
 * reads devices through the twin (real SmartThings devices of the zone and every simulated device) and, for staff,
 * finds devices and explains faults.
 *
 *   GET   -> { ok, ready, problem, model, skills, llm }   is the assistant up, and can it reach Ollama + its model
 *   POST  {messages: [{role, content}], room?} -> the chat event stream (docs/contracts/agent-api.md)
 *
 * The role comes from the sign-in cookie (proxy.ts): `tech:<key>` is a technician, anything else is the
 * administrator (also when sign-in is off in the local demo). Guests use /api/guest/{pass}/chat.
 */
export async function GET() { return NextResponse.json(await agentHealth()); }

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const role = (req.cookies.get('twin_role')?.value ?? '').startsWith('tech:') ? 'technician' : 'admin';
  return agentTurn({ messages: Array.isArray(b.messages) ? b.messages : [] }, { kind: 'host', role, ...(typeof b.room === 'string' && b.room ? { room: b.room } : {}) });
}
