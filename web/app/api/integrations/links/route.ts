import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as ST from '@/lib/integrations/smartthings';
import { byId } from '@/lib/sim/engine';

export const dynamic = 'force-dynamic';

/** POST {localId, stId, component?}: link a twin device to a real SmartThings device. DELETE ?localId=: unlink. */
export async function POST(req: NextRequest) {
  const p = z.object({ localId: z.string(), stId: z.string().min(4).max(80), component: z.string().max(40).optional(), label: z.string().max(80).optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  const d = byId[p.data.localId];
  if (!d) return NextResponse.json({ error: `Unknown device ${p.data.localId}` }, { status: 404 });
  ST.setLink({ localId: d.id, stId: p.data.stId, component: p.data.component ?? 'main', label: p.data.label, type: d.type });
  const status = await ST.refresh(d.id, d.type).catch(() => null);
  return NextResponse.json({ ok: true, links: ST.links(), status });
}

export async function DELETE(req: NextRequest) {
  ST.unlink(req.nextUrl.searchParams.get('localId') ?? '');
  return NextResponse.json({ ok: true, links: ST.links() });
}
