import { NextResponse } from 'next/server';
import { floor } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/floor: rooms, every device with position and live health. */
export async function GET() {
  return NextResponse.json(floor());
}
