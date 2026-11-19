import { rt } from '@/lib/sim/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/building/plan: the uploaded floor plan image (404 for the sample home). */
export async function GET() {
  if (!rt.plan) return new Response('No floor plan uploaded', { status: 404 });
  return new Response(new Uint8Array(rt.plan.bytes), { headers: { 'Content-Type': rt.plan.mime, 'Cache-Control': 'no-store' } });
}
