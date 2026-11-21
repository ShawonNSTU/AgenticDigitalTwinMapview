import { NextRequest, NextResponse } from 'next/server';
import { accountDevices, removeSimulated, syncAccount } from '@/lib/integrations/stsync';

export const dynamic = 'force-dynamic';

/** GET: devices in the connected SmartThings account, with their room and the map's device type for them.
 *  POST {sync: true}: bring new devices onto the map again. POST {removeSimulated: true}: remove the zone's
 *  devices that have no real SmartThings device. */
export async function GET() {
  try { return NextResponse.json({ devices: await accountDevices() }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  try {
    if (b?.removeSimulated) return NextResponse.json({ removed: removeSimulated() });
    return NextResponse.json({ sync: await syncAccount() });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
}
