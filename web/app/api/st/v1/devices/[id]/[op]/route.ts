import { NextRequest, NextResponse } from 'next/server';
import { resolveDevice, runCommands, sessionFor, statusDoc } from '@/lib/integrations/stagent';

export const dynamic = 'force-dynamic';

/**
 * The twin's SmartThings-compatible device API, for the SmartThings agent (assistant/, IOT_API_BASE_URL =
 * http://<web>/api/st/v1/devices). Same paths and bodies as api.smartthings.com/v1/devices:
 *   GET  {id}/status    -> {components: {main: {capability: {attribute: {value, unit?, timestamp}}}}}
 *   GET  {id}/health    -> {deviceId, state: "ONLINE" | "OFFLINE"}
 *   POST {id}/commands  {commands: [{component, capability, command, arguments}]} -> {results: [{id, status}]}
 * {id} is a twin device id, or the real SmartThings deviceId of a linked device. The bearer token is the chat
 * turn's session (lib/integrations/stagent.ts), which limits what the agent can reach; commands run through the
 * twin (3D view, zone rules, the real device when linked, guest permissions).
 */
const err = (status: number, message: string) => NextResponse.json({ error: { code: status === 401 ? 'Unauthorized' : status === 404 ? 'NotFoundError' : 'ConstraintViolationError', message } }, { status });

async function scoped(req: NextRequest, ctx: { params: Promise<{ id: string; op: string }> }) {
  const { id, op } = await ctx.params;
  const scope = sessionFor(req.headers.get('authorization'));
  if (!scope) return { error: err(401, 'Unauthorized: no valid agent session') };
  const d = resolveDevice(decodeURIComponent(id), scope);
  if (!d) return { error: err(404, `Device ${id} not found`) };
  return { d, op, scope };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; op: string }> }) {
  const s = await scoped(req, ctx);
  if ('error' in s) return s.error;
  const doc = statusDoc(s.d);
  if (s.op === 'status') return NextResponse.json({ components: doc.components });
  if (s.op === 'health') return NextResponse.json({ deviceId: s.d.id, state: doc.online ? 'ONLINE' : 'OFFLINE' });
  return err(404, `Unknown path ${s.op}`);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; op: string }> }) {
  const s = await scoped(req, ctx);
  if ('error' in s) return s.error;
  if (s.op !== 'commands') return err(404, `Unknown path ${s.op}`);
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.commands) || !body.commands.length) return err(422, 'The request body is malformed: expected {"commands": [...]}');
  const r = await runCommands(s.d, body.commands, s.scope);
  if (!r.ok) return err(r.status, r.error);
  return NextResponse.json({ results: body.commands.map((_: unknown, i: number) => ({ id: `${s.d.id}-${Date.now()}-${i}`, status: 'COMPLETED' })) });
}
