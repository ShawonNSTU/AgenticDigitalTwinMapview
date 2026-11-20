import { NextResponse } from 'next/server';
import { alerts } from '@/lib/sim/maintenance';

export const dynamic = 'force-dynamic';

/** GET: every open alert (devices that are not healthy), most serious first. */
export async function GET() { return NextResponse.json({ alerts: alerts() }); }
