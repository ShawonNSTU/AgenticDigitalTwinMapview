import { NextResponse } from 'next/server';
import * as ST from '@/lib/integrations/smartthings';

export const dynamic = 'force-dynamic';

/** GET: devices in the connected SmartThings account (to link them to devices on the twin). */
export async function GET() {
  try { return NextResponse.json({ devices: await ST.accountDevices() }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
}
