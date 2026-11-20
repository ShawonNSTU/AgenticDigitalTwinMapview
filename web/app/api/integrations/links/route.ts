import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as ST from '@/lib/integrations/smartthings';
import { byId } from '@/lib/sim/engine';

export const dynamic = 'force-dynamic';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Link every twin device whose name is the label of a device in the SmartThings account (optionally in one
 *  room): the SmartThings Experience Zone's devices carry the names its SmartThings app uses. */
async function linkByName(room?: string) {
  const acct = await ST.accountDevices();
  const done: { localId: string; stId: string; label: string }[] = [];
  for (const d of Object.values(byId) as any[]) {
    if (room && d.room !== room) continue;
    if (ST.link(d.id)) continue;
    const name = norm(String(d.name).split(' · ')[0]);
    const hit = acct.find((a: any) => norm(a.label) === name);
    if (!hit) continue;
    const desc = await ST.describe(hit.stId, 'main').catch(() => null);
    if (!desc || 'error' in desc) continue;
    ST.setLink({ localId: d.id, stId: hit.stId, component: 'main', label: hit.label, type: d.type, capabilities: desc.capabilities });
    await ST.refresh(d.id, d.type).catch(() => null);
    done.push({ localId: d.id, stId: hit.stId, label: hit.label });
  }
  return done;
}

/** POST {localId, stId, component?}: link a twin device to a real SmartThings device.
 *  POST {byName: true, room?}: link every device whose name matches a SmartThings label. DELETE ?localId=: unlink. */
export async function POST(req: NextRequest) {
  const raw = await req.clone().json().catch(() => ({}));
  if (raw?.byName) {
    try { const linked = await linkByName(typeof raw.room === 'string' ? raw.room : undefined); return NextResponse.json({ ok: true, linked, links: ST.links() }); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
  }
  const p = z.object({ localId: z.string(), stId: z.string().min(4).max(80), component: z.string().max(40).optional(), label: z.string().max(80).optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  const d = byId[p.data.localId];
  if (!d) return NextResponse.json({ error: `Unknown device ${p.data.localId}` }, { status: 404 });
  const comp = p.data.component ?? 'main';
  const desc = await ST.describe(p.data.stId, comp).catch(e => ({ error: (e as Error).message }));
  if ('error' in desc) return NextResponse.json({ error: desc.error }, { status: 502 });
  ST.setLink({ localId: d.id, stId: p.data.stId, component: comp, label: p.data.label ?? desc.label, type: d.type, capabilities: desc.capabilities });
  const status = await ST.refresh(d.id, d.type).catch(() => null);
  return NextResponse.json({ ok: true, links: ST.links(), status });
}

export async function DELETE(req: NextRequest) {
  ST.unlink(req.nextUrl.searchParams.get('localId') ?? '');
  return NextResponse.json({ ok: true, links: ST.links() });
}
