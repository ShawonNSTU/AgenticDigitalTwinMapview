import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setTariff, summary } from '@/lib/experience/energy';
import { ensureExperience } from '@/lib/experience/loop';

export const dynamic = 'force-dynamic';

/** GET /api/energy[?room=key]: live watts, today's kWh, cost, CO2, avoided energy, per room and per device. */
export async function GET(req: NextRequest) {
  ensureExperience();
  return NextResponse.json(summary(req.nextUrl.searchParams.get('room') ?? undefined));
}

const Tariff = z.object({ perKWh: z.number().min(0).max(100).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), co2PerKWh: z.number().min(0).max(5).optional() });
/** PATCH /api/energy {perKWh, currency, co2PerKWh}: the hotel's tariff and grid carbon factor. */
export async function PATCH(req: NextRequest) {
  const p = Tariff.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message }, { status: 400 });
  return NextResponse.json({ tariff: setTariff(p.data) });
}
