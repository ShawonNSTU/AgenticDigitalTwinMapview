import { NextResponse } from 'next/server';
import { floor } from '@/lib/sim/runtime';
import { snapshot } from '@/lib/experience/loop';

export const dynamic = 'force-dynamic';

/** GET /api/floor: rooms, every device with position and live health, and the live experience data the 3D view
 *  draws (per-room comfort and its field sources, live watts, eco rooms, guest journeys, predictions, dispatches). */
export async function GET() {
  return NextResponse.json({ ...floor(), experience: snapshot() });
}
