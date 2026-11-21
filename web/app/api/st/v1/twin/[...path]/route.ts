import { NextRequest, NextResponse } from 'next/server';
import { resolveDevice, sessionFor, twinFloor, twinInsight } from '@/lib/integrations/stagent';
import { runOp } from '@/lib/integrations/stops';
import { knowledge } from '@/lib/kg/graph';

export const dynamic = 'force-dynamic';

/**
 * The twin's read-only diagnostics API for the assistant (assistant, TWIN_API_BASE_URL), staff sessions only:
 *   GET floor            -> rooms and every device with its health (and the finding's title when not healthy)
 *   GET kg               -> the knowledge graph's documents for this session's scope (?graph=1 adds nodes and edges)
 *   GET insight/{id}     -> one device's parts, health and the finding with evidence and guided steps
 *   POST ops/{op}        -> what the assistant may do beyond devices (lib/integrations/stops.ts): layout, alerts,
 *                           alert_update, clear_fault, simulate_fault, sim, passes, pass_create, pass_revoke, routines, routine_run
 * Same bearer session as /api/st/v1/devices. A guest session is refused: a guest's assistant has no diagnostics.
 */
const err = (status: number, message: string) => NextResponse.json({ error: { message } }, { status });

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const scope = sessionFor(req.headers.get('authorization'));
  if (!scope) return err(401, 'Unauthorized: no valid assistant session');
  // the knowledge graph: every scope gets its own cut (a guest: public floor facts, own room, own stay)
  if (path.length === 1 && path[0] === 'kg') { const k = knowledge(scope); return NextResponse.json(req.nextUrl.searchParams.get('graph') ? k : { version: k.version, scope: k.scope, docs: k.docs, stats: k.stats }); }
  if (scope.kind !== 'host') return err(403, 'Diagnostics are for staff only');
  if (path.length === 1 && path[0] === 'floor') return NextResponse.json(twinFloor(scope));
  if (path.length === 2 && path[0] === 'insight') {
    const d = resolveDevice(decodeURIComponent(path[1]), scope);
    const out = d ? twinInsight(d, scope) : null;
    return out ? NextResponse.json(out) : err(404, `Device ${path[1]} not found`);
  }
  return err(404, `Unknown path ${path.join('/')}`);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const scope = sessionFor(req.headers.get('authorization'));
  if (!scope) return err(401, 'Unauthorized: no valid assistant session');
  if (path.length !== 2 || path[0] !== 'ops') return err(404, `Unknown path ${path.join('/')}`);
  const r = await runOp(path[1], await req.json().catch(() => ({})), scope);
  return NextResponse.json(r.body, { status: r.status });
}
