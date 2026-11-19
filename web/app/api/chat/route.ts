import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/chat: thin proxy to the agent backend's streaming /chat endpoint.
 * Keeps the agent URL server-side and lets the browser use one origin.
 */
export async function POST(req: NextRequest) {
  const base = process.env.AGENT_URL ?? 'http://localhost:8000';
  try {
    const upstream = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await req.text() });
    return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  } catch {
    const msg = `event: error\ndata: ${JSON.stringify({ message: `Agent backend not reachable at ${base}. Start agent-backend first.` })}\n\n`;
    return new Response(msg, { status: 502, headers: { 'Content-Type': 'text/event-stream' } });
  }
}
