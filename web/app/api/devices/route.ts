import { NextRequest, NextResponse } from 'next/server';
import { floor } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/**
 * GET /api/devices?type=ac&room=bedroom&health=fault
 * Plain filtering. Natural-language search lives in the agent backend.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  let list = floor().devices;
  for (const k of ['type', 'room', 'health'] as const) {
    const v = q.get(k);
    if (v) list = list.filter(d => d[k] === v);
  }
  return NextResponse.json({ count: list.length, devices: list });
}
