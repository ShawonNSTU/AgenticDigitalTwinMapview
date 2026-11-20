import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { addRecord, history } from '@/lib/sim/maintenance';

export const dynamic = 'force-dynamic';

const Body = z.object({ deviceId: z.string(), status: z.enum(['acknowledged', 'investigating', 'resolved']), cause: z.string().max(300).optional(), action: z.string().max(300).optional(), notes: z.string().max(1000).optional(), by: z.string().max(40).optional(), alert: z.string().max(160).optional() });

/** GET ?device=ID: maintenance records (newest first). POST: a technician records an investigation step. */
export async function GET(req: NextRequest) { return NextResponse.json({ records: history(req.nextUrl.searchParams.get('device') ?? undefined) }); }

export async function POST(req: NextRequest) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  try { return NextResponse.json(addRecord(p.data)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
