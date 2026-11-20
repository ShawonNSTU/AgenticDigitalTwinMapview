import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setTechnicians, technicians } from '@/lib/sim/maintenance';

export const dynamic = 'force-dynamic';

const Tech = z.object({ id: z.string().min(1).max(30), name: z.string().min(1).max(60), types: z.array(z.string()).max(40), rooms: z.array(z.string()).max(200).default([]) });

/** GET: technicians and what they cover (device types, optionally rooms). POST {technicians}: replace the list. */
export async function GET() { return NextResponse.json({ technicians: technicians() }); }
export async function POST(req: NextRequest) {
  const p = z.object({ technicians: z.array(Tech).min(1).max(50) }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  return NextResponse.json({ technicians: setTechnicians(p.data.technicians) });
}
