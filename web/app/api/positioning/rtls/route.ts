import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { config, setFix, tokenForTag } from '@/lib/sim/positioning';

export const dynamic = 'force-dynamic';

const Fix = z.object({ tag: z.string().min(1).max(64), x: z.number(), z: z.number(), accuracy: z.number().min(0).max(50).optional() });

/** Webhook for the hotel's indoor positioning system (UWB/BLE). Header x-rtls-key: the key from /integrations.
 *  Body: one fix {tag, x, z, accuracy?} in floor metres, or {fixes: [...]}. Fixes for tags not bound to a pass
 *  are ignored. */
export async function POST(req: NextRequest) {
  if (req.headers.get('x-rtls-key') !== config().rtlsKey) return NextResponse.json({ error: 'Wrong or missing x-rtls-key' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const list = z.array(Fix).max(500).safeParse(Array.isArray(body.fixes) ? body.fixes : [body]);
  if (!list.success) return NextResponse.json({ error: list.error.message }, { status: 400 });
  let used = 0;
  for (const f of list.data) {
    const token = tokenForTag(f.tag);
    if (!token) continue;
    setFix(token, { x: f.x, z: f.z, accuracy: f.accuracy ?? 0.5, source: 'rtls' });
    used++;
  }
  return NextResponse.json({ ok: true, accepted: used, ignored: list.data.length - used });
}
